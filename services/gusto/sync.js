/**
 * Idempotent push/pull between our HR data and Gusto.
 * Every record gets a link (gusto_links): our id <-> Gusto uuid + version + per-part content hashes + sync state.
 * Re-running a sync with nothing changed makes no Gusto calls (hashes match). Failures are recorded per record
 * (gusto_errors) and the rest of the batch continues.
 *
 * ctx = { orgId, client, store, conn, opts, log, loadPeople?, loadLeave?, org? }
 */
const { decryptField } = require('../pii-crypto');
const mapping = require('./mapping');
const { GustoError } = require('./client');

const cidOf = (ctx) => {
    if (!ctx.conn || !ctx.conn.companyUuid) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' });
    return ctx.conn.companyUuid;
};
const emit = (ctx, level, msg, f) => { try { (ctx.log || {})[level](`gusto sync ${msg}`, { orgId: ctx.orgId, ...f }); } catch (_) {} };

/* ------------------------------- loading our data ------------------------------- */

async function loadPeople(ctx) {
    if (ctx.loadPeople) return ctx.loadPeople(ctx.orgId);
    const { rawCollection } = require('../../config/firebase');
    const snap = await rawCollection('users').where('orgId', '==', ctx.orgId).get();
    return snap.docs.map((d) => mapping.personFromDoc(d.id, d.data())).filter((p) => p.classification || p.payType || p.home);
}
async function loadLeave(ctx) {
    if (ctx.loadLeave) return ctx.loadLeave(ctx.orgId);
    const { rawCollection } = require('../../config/firebase');
    const snap = await rawCollection('leave_requests').where('orgId', '==', ctx.orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function loadOrg(ctx) {
    if (ctx.org) return ctx.org;
    const { rawCollection } = require('../../config/firebase');
    const s = await rawCollection('organizations').doc(ctx.orgId).get();
    return (typeof s.exists === 'function' ? s.exists() : s.exists) ? s.data() : {};
}

const errMessage = (e) => (e && e.message ? String(e.message).slice(0, 400) : 'Unknown error');

/* ------------------------------- locations ------------------------------- */

/** Company address(es) as Gusto locations. We hold one business address; people in other states are flagged. */
async function syncLocations(ctx) {
    const cid = cidOf(ctx);
    const org = await loadOrg(ctx);
    const addr = org.usProfile && org.usProfile.businessAddress;
    if (!addr || !addr.line1) return { status: 'blocked', reason: 'The company address is not filled in (Company profile).' };
    const body = mapping.toGustoLocation(addr, org.phone || org.contactPhone);
    const h = mapping.hash(body);
    let link = await ctx.store.getLink(ctx.orgId, 'location', 'hq');
    const { client } = ctx;
    if (!link || !link.gustoUuid) {
        const existing = (await client.get(`/v1/companies/${cid}/locations`)).find((l) => l.street_1 === body.street_1 && l.zip === body.zip);
        const loc = existing || await client.post(`/v1/companies/${cid}/locations`, body, { idempotencyKey: `kylrx:${ctx.orgId}:location:hq:1` });
        link = await ctx.store.saveLink(ctx.orgId, 'location', 'hq', { gustoUuid: loc.uuid, version: loc.version, hash: h, syncState: 'synced', state: addr.state, lastSyncedAt: new Date().toISOString() });
        return { status: 'created', gustoUuid: loc.uuid, state: addr.state };
    }
    if (link.hash !== h) {
        const r = await client.putVersioned(`/v1/locations/${link.gustoUuid}`.replace('/locations/', '/locations/'), `/v1/locations/${link.gustoUuid}`, () => body, { });
        link = await ctx.store.saveLink(ctx.orgId, 'location', 'hq', { version: r.data.version, hash: h, syncState: 'synced', state: addr.state, lastSyncedAt: new Date().toISOString() });
        return { status: 'updated', gustoUuid: link.gustoUuid, state: addr.state };
    }
    return { status: 'unchanged', gustoUuid: link.gustoUuid, state: addr.state };
}

async function locationFor(ctx) {
    const l = await ctx.store.getLink(ctx.orgId, 'location', 'hq');
    return l && l.gustoUuid ? l : null;
}

/* ------------------------------- one person ------------------------------- */

async function findGustoByEmail(ctx, email) {
    if (!ctx._gustoEmployees) ctx._gustoEmployees = await ctx.client.paginate(`/v1/companies/${cidOf(ctx)}/employees`);
    return ctx._gustoEmployees.find((g) => g.email && g.email.toLowerCase() === String(email).toLowerCase() && !g.terminated) || null;
}

/**
 * Push one person. Returns { status: 'synced'|'unchanged'|'blocked'|'skipped'|'error', ... }.
 * Gusto is the source of truth for W-4, state tax, bank and pay once the employee is onboarded there, so those parts
 * are only pushed while the employee is not onboarded yet, unless opts.overwrite is true.
 */
async function syncPerson(ctx, person, o = {}) {
    const { orgId, store, client } = ctx;
    const problems = mapping.problemsFor(person);
    if (!person.active) return { status: 'skipped', userId: person.id, reason: 'This person is no longer active.' };
    if (problems.length) {
        await store.saveLink(orgId, 'employee', person.id, { syncState: 'blocked', blockedReasons: problems, lastCheckedAt: new Date().toISOString() });
        return { status: 'blocked', userId: person.id, reasons: problems };
    }
    try {
        const cid = cidOf(ctx);
        let link = await store.getLink(orgId, 'employee', person.id);
        const hashes = { ...((link && link.hashes) || {}) };
        const meta = { ...((link && link.meta) || {}) };
        let ssn = null;
        if (ctx.opts && ctx.opts.sendSsn && person.ssnEnc) {
            try { ssn = decryptField(person.ssnEnc, `${orgId}:${person.id}`); } catch (_) { ssn = null; }
        }
        const empBody = mapping.toGustoEmployee(person, ssn);
        const { ssn: _s, ...empForHash } = empBody;
        const want = {
            employee: mapping.hash({ ...empForHash, ssn: person.ssnLast4 || null }),
            home: mapping.hash(mapping.toGustoHomeAddress(person)),
            job: mapping.hash(mapping.toGustoJob(person)),
            comp: mapping.hash(mapping.toGustoCompensation(person)),
            w4: mapping.hash(mapping.toGustoFederalTaxes(person.w4) || {})
        };
        const loc = await locationFor(ctx);
        want.work = mapping.hash({ loc: loc && loc.gustoUuid, st: person.workState });
        // only people who have bank details or state tax answers get these parts (so nothing changes for the others)
        if (person.bank && person.bank.length) want.bank = mapping.bankHash(person.bank);
        if (person.stateTax && Object.keys(person.stateTax).length) want.stateTax = mapping.stateTaxHash(person.stateTax);
        let calls = 0;
        let gustoUuid = link && link.gustoUuid;
        let version = link && link.version;
        let onboarded = Boolean(link && link.gusto && link.gusto.onboarded);

        // 1. the person
        if (!gustoUuid) {
            const existing = await findGustoByEmail(ctx, person.email);
            if (existing) { gustoUuid = existing.uuid; version = existing.version; Object.assign(meta, { adopted: true }); } else {
                const created = await client.post(`/v1/companies/${cid}/employees`, empBody, { idempotencyKey: `kylrx:${orgId}:employee:${person.id}:${(link && link.createAttempt) || 1}` });
                gustoUuid = created.uuid; version = created.version; onboarded = Boolean(created.onboarded);
                if (ctx._gustoEmployees) ctx._gustoEmployees.push(created);
            }
            hashes.employee = existing ? undefined : want.employee; calls += 1;
            link = await store.saveLink(orgId, 'employee', person.id, { gustoUuid, version, syncState: 'pending', hashes, meta, blockedReasons: null });
        } else if (hashes.employee !== want.employee || o.force) {
            const r = await client.putVersioned(`/v1/employees/${gustoUuid}`, `/v1/employees/${gustoUuid}`, (cur) => {
                const diff = {};
                for (const k of ['first_name', 'last_name', 'email', 'date_of_birth', 'middle_initial']) if (empBody[k] !== undefined && empBody[k] !== (cur[k] || '')) diff[k] = empBody[k];
                if (ssn && hashes.employee !== want.employee) diff.ssn = empBody.ssn;
                onboarded = Boolean(cur.onboarded);
                return Object.keys(diff).length ? diff : null;
            });
            version = r.data.version; hashes.employee = want.employee; calls += 1;
        }
        const pushPay = !onboarded || o.overwrite;

        // 2. home address
        if (hashes.home !== want.home) {
            const body = mapping.toGustoHomeAddress(person);
            if (!meta.homeUuid) { const h = await client.post(`/v1/employees/${gustoUuid}/home_addresses`, body, { idempotencyKey: `kylrx:${orgId}:home:${person.id}:${want.home}` }); meta.homeUuid = h.uuid; } else {
                await client.putVersioned(`/v1/home_addresses/${meta.homeUuid}`, `/v1/home_addresses/${meta.homeUuid}`, () => body);
            }
            hashes.home = want.home; calls += 1;
        }
        // 3. work address (the company location)
        if (loc && hashes.work !== want.work) {
            const w = await client.post(`/v1/employees/${gustoUuid}/work_addresses`, { location_uuid: loc.gustoUuid, effective_date: person.startDate }, { idempotencyKey: `kylrx:${orgId}:work:${person.id}:${want.work}` });
            meta.workUuid = w.uuid; hashes.work = want.work; calls += 1;
        }
        // 4. job
        if (!meta.jobUuid) {
            const j = await client.post(`/v1/employees/${gustoUuid}/jobs`, mapping.toGustoJob(person), { idempotencyKey: `kylrx:${orgId}:job:${person.id}:1` });
            const comp = (j.compensations || [])[0] || {};
            meta.jobUuid = j.uuid; meta.compensationUuid = comp.uuid || null; hashes.job = want.job; hashes.comp = undefined; calls += 1;
        } else if (hashes.job !== want.job) {
            const body = mapping.toGustoJob(person);
            await client.putVersioned(`/v1/jobs/${meta.jobUuid}`, `/v1/jobs/${meta.jobUuid}`, (cur) => (cur.title === body.title ? null : { title: body.title }));
            hashes.job = want.job; calls += 1;
        }
        // 5. pay
        if (meta.compensationUuid && hashes.comp !== want.comp && pushPay) {
            const body = mapping.toGustoCompensation(person);
            await client.putVersioned(`/v1/compensations/${meta.compensationUuid}`, `/v1/compensations/${meta.compensationUuid}`, (cur) => (cur.rate === body.rate && cur.payment_unit === body.payment_unit && cur.flsa_status === body.flsa_status ? null : body));
            hashes.comp = want.comp; calls += 1;
        }
        // 6. W-4
        const w4 = mapping.toGustoFederalTaxes(person.w4);
        if (w4 && hashes.w4 !== want.w4 && pushPay) {
            await client.putVersioned(`/v1/employees/${gustoUuid}/federal_taxes`, `/v1/employees/${gustoUuid}/federal_taxes`, () => w4);
            hashes.w4 = want.w4; calls += 1;
        }

        // 7. bank accounts and how pay is split
        if (want.bank && hashes.bank !== want.bank && pushPay) {
            const r = await pushBank(ctx, person, gustoUuid, meta, want.bank);
            Object.assign(meta, r.meta);
            if (r.sent) { hashes.bank = want.bank; calls += r.calls; }
        }
        // 8. state tax answers
        if (want.stateTax && hashes.stateTax !== want.stateTax && pushPay) {
            const r = await pushStateTax(ctx, person, gustoUuid);
            meta.stateTaxNote = r.note; hashes.stateTax = want.stateTax; calls += r.calls;
        }

        link = await store.saveLink(orgId, 'employee', person.id, {
            gustoUuid, version, hashes: stripUndefined(hashes), meta, syncState: 'synced', lastError: null, blockedReasons: null, lastSyncedAt: new Date().toISOString(),
            gusto: { onboarded, ...((link && link.gusto) || {}), ...(onboarded ? { onboarded: true } : {}) }
        });
        await store.resolveErrors(orgId, 'person', person.id);
        emit(ctx, 'info', 'person', { userId: person.id, calls });
        return { status: calls ? 'synced' : 'unchanged', userId: person.id, gustoUuid, calls };
    } catch (e) {
        await store.saveLink(orgId, 'employee', person.id, { syncState: 'error', lastError: errMessage(e), lastErrorAt: new Date().toISOString() });
        await store.logError(orgId, { scope: 'person', ref: person.id, name: person.name, code: e.code || 'error', message: errMessage(e) });
        emit(ctx, 'warn', 'person_failed', { userId: person.id, code: e.code, message: errMessage(e) });
        return { status: 'error', userId: person.id, error: errMessage(e), code: e.code || 'error' };
    }
}
function stripUndefined(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }

/**
 * Bank accounts and the pay split for one person (US-F03).
 * Account numbers are decrypted here, at the moment they are sent, and go nowhere else: not into logs (the client
 * masks account_number and routing_number), not into the link, not into errors.
 * Order matters: the new accounts are added and the pay method is switched to them BEFORE the accounts we sent
 * earlier are removed, so a failure half way leaves the person's old, working setup in place.
 * VERIFY against Gusto: POST /v1/employees/{id}/bank_accounts, DELETE /v1/employees/{id}/bank_accounts/{bank_id},
 * GET/PUT /v1/employees/{id}/payment_method (PUT needs `version`).
 */
async function pushBank(ctx, person, gustoUuid, meta, bankHash) {
    const { orgId, client, store } = ctx;
    const check = mapping.toGustoPaymentSplits(person.bank);
    if (!check.ok) return { sent: false, calls: 0, meta: { bankNote: check.reason } };
    const numbers = new Map();
    for (const a of person.bank) {
        let n = null;
        try { n = a.accountNumberEnc ? decryptField(a.accountNumberEnc, `${orgId}:${person.id}:bank`) : null; } catch (_) { n = null; }
        if (!n) return { sent: false, calls: 0, meta: { bankNote: 'A bank account number on file could not be read. Ask the person to enter their bank details again.' } };
        numbers.set(a.id, n);
    }
    const gen = meta.bankGen || 0; const tries = meta.bankTries || 0;
    const uuids = new Map(); let calls = 0;
    try {
        for (const a of person.bank) {
            const made = await client.post(`/v1/employees/${gustoUuid}/bank_accounts`, mapping.toGustoBankAccount(a, numbers.get(a.id)), { idempotencyKey: `kylrx:${orgId}:bank:${person.id}:${a.id}:${bankHash}:${gen}:${tries}` });
            uuids.set(a.id, made.uuid); calls += 1;
        }
        const body = mapping.toGustoPaymentSplits(person.bank, (a) => uuids.get(a.id)).body;
        await client.putVersioned(`/v1/employees/${gustoUuid}/payment_method`, `/v1/employees/${gustoUuid}/payment_method`, () => body);
        calls += 1;
    } catch (e) {
        // a clear refusal is replayed for the same idempotency key: move the key on for the next try
        if (e.status >= 400 && e.status < 500 && e.status !== 429) await store.saveLink(orgId, 'employee', person.id, { meta: { bankTries: tries + 1 } });
        throw e;
    }
    const fresh = [...uuids.values()];
    for (const old of (meta.bankUuids || []).filter((u) => !fresh.includes(u))) {
        try { await client.del(`/v1/employees/${gustoUuid}/bank_accounts/${old}`); calls += 1; } catch (e) { if (e.code !== 'not_found') emit(ctx, 'warn', 'old_bank_account_not_removed', { userId: person.id, code: e.code }); }
    }
    return { sent: true, calls, meta: { bankUuids: fresh, bankGen: gen + 1, bankTries: 0, bankNote: null, bankSentAt: new Date().toISOString() } };
}

/**
 * State tax answers for one person (US-F03): only answers to questions the provider asks are sent.
 * VERIFY against Gusto: GET/PUT /v1/employees/{id}/state_taxes (see mapping.toGustoStateTaxes).
 */
async function pushStateTax(ctx, person, gustoUuid) {
    const provider = await ctx.client.get(`/v1/employees/${gustoUuid}/state_taxes`);
    const r = mapping.toGustoStateTaxes(person.stateTax, provider);
    let calls = 1;
    if (r.states.length) { await ctx.client.put(`/v1/employees/${gustoUuid}/state_taxes`, { states: r.states }); calls += 1; }
    const note = r.unknown.length ? `Not sent, because Gusto does not ask for them: ${r.unknown.join(', ')}`.slice(0, 300) : null;
    return { calls, sent: r.sent, note, unknown: r.unknown, unanswered: r.unanswered };
}

/** The provider's state tax questions for a person, next to the answers saved here */
async function stateTaxFor(ctx, person) {
    const link = await ctx.store.getLink(ctx.orgId, 'employee', person.id);
    const saved = person.stateTax || {};
    if (!link || !link.gustoUuid) return { inGusto: false, states: Object.keys(saved).map((state) => ({ state, questions: [], saved: (saved[state] && saved[state].answers) || {} })) };
    const provider = await ctx.client.get(`/v1/employees/${link.gustoUuid}/state_taxes`);
    return {
        inGusto: true,
        states: provider.map((s) => ({
            state: s.state, isWorkState: Boolean(s.is_work_state), saved: (saved[s.state] && saved[s.state].answers) || {},
            questions: (s.questions || []).map((q) => ({ key: q.key, label: q.label || q.key, description: q.description || '', type: (q.input_question_format && q.input_question_format.type) || 'Text', options: ((q.input_question_format && q.input_question_format.options) || []).map((o) => ({ value: o.value, label: o.label || String(o.value) })), current: ((q.answers || [])[0] || {}).value ?? null }))
        }))
    };
}

/** Send one person's saved state tax answers now (an explicit action by payroll, so it does not wait for a people sync) */
async function sendStateTax(ctx, person) {
    const link = await ctx.store.getLink(ctx.orgId, 'employee', person.id);
    if (!link || !link.gustoUuid) throw new GustoError('This person is not in Gusto yet. Send people to Gusto first.', { status: 409, code: 'not_linked' });
    const r = await pushStateTax(ctx, person, link.gustoUuid);
    await ctx.store.saveLink(ctx.orgId, 'employee', person.id, { hashes: { stateTax: mapping.stateTaxHash(person.stateTax) }, meta: { stateTaxNote: r.note, stateTaxSentAt: new Date().toISOString() } });
    return { sent: r.sent, notAsked: r.unknown, unanswered: r.unanswered };
}

/** Push everyone (or the given ids). Locations first because work addresses need one. */
async function syncPeople(ctx, { ids = null, force = false, overwrite = false } = {}) {
    let locResult = null;
    try { locResult = await syncLocations(ctx); } catch (e) { await ctx.store.logError(ctx.orgId, { scope: 'location', ref: 'hq', code: e.code || 'error', message: errMessage(e) }); locResult = { status: 'error', error: errMessage(e) }; }
    const people = (await loadPeople(ctx)).filter((p) => !ids || ids.includes(p.id));
    const results = [];
    for (const p of people) results.push(await syncPerson(ctx, p, { force, overwrite }));
    const count = (s) => results.filter((r) => r.status === s).length;
    return { location: locResult, total: results.length, synced: count('synced'), unchanged: count('unchanged'), blocked: count('blocked'), skipped: count('skipped'), errors: count('error'), results };
}

/* ------------------------------- pull ------------------------------- */

/** Read employees back: onboarding state, versions, pay drift, and Gusto people we have no link for. */
async function pullPeople(ctx) {
    const cid = cidOf(ctx);
    const list = await ctx.client.paginate(`/v1/companies/${cid}/employees`);
    const links = (await ctx.store.listLinks(ctx.orgId, 'employee')).filter((l) => l.gustoUuid);
    const byUuid = new Map(links.map((l) => [l.gustoUuid, l]));
    const people = new Map((await loadPeople(ctx)).map((p) => [p.id, p]));
    const unmatched = [];
    let updated = 0;
    for (const g of list) {
        const info = mapping.fromGustoEmployee(g);
        const link = byUuid.get(g.uuid);
        if (!link) { unmatched.push({ gustoUuid: g.uuid, email: g.email || null, name: [g.first_name, g.last_name].filter(Boolean).join(' ') }); continue; }
        const person = people.get(link.ourId);
        const d = person ? mapping.drift(person, info) : [];
        await ctx.store.saveLink(ctx.orgId, 'employee', link.ourId, {
            version: info.version, gusto: { onboarded: info.onboarded, onboardingStatus: info.onboardingStatus, terminated: info.terminated, rate: info.rate, paymentUnit: info.paymentUnit }, drift: d,
            meta: { jobUuid: info.jobUuid || (link.meta || {}).jobUuid || null, compensationUuid: info.compensationUuid || (link.meta || {}).compensationUuid || null }, lastPulledAt: new Date().toISOString()
        });
        updated += 1;
    }
    const seen = new Set(list.map((g) => g.uuid));
    const missingInGusto = links.filter((l) => !seen.has(l.gustoUuid)).map((l) => l.ourId);
    return { gustoCount: list.length, updated, unmatched, missingInGusto };
}

/* ------------------------------- pay schedules ------------------------------- */

async function syncPaySchedule(ctx, settings) {
    const cid = cidOf(ctx);
    const errors = mapping.validatePaySchedule(settings);
    if (errors.length) return { status: 'invalid', errors };
    const body = mapping.toGustoPaySchedule(settings);
    const h = mapping.hash(body);
    const link = await ctx.store.getLink(ctx.orgId, 'pay_schedule', 'default');
    if (!link || !link.gustoUuid) {
        const existing = (await ctx.client.get(`/v1/companies/${cid}/pay_schedules`)).find((s) => s.frequency === body.frequency && s.anchor_pay_date === body.anchor_pay_date);
        const s = existing || await ctx.client.post(`/v1/companies/${cid}/pay_schedules`, body, { idempotencyKey: `kylrx:${ctx.orgId}:payschedule:default:1` });
        await ctx.store.saveLink(ctx.orgId, 'pay_schedule', 'default', { gustoUuid: s.uuid, version: s.version, hash: h, syncState: 'synced', lastSyncedAt: new Date().toISOString() });
        return { status: 'created', gustoUuid: s.uuid };
    }
    if (link.hash === h) return { status: 'unchanged', gustoUuid: link.gustoUuid };
    const r = await ctx.client.putVersioned(`/v1/companies/${cid}/pay_schedules/${link.gustoUuid}`, `/v1/companies/${cid}/pay_schedules/${link.gustoUuid}`, () => body);
    await ctx.store.saveLink(ctx.orgId, 'pay_schedule', 'default', { version: r.data.version, hash: h, syncState: 'synced', lastSyncedAt: new Date().toISOString() });
    return { status: 'updated', gustoUuid: link.gustoUuid };
}

/* ------------------------------- departments ------------------------------- */

/** VERIFY: department endpoints per the Gusto docs; harmless if a company does not use departments. */
async function syncDepartments(ctx) {
    const cid = cidOf(ctx);
    const people = await loadPeople(ctx);
    const names = [...new Set(people.map((p) => p.department).filter(Boolean))];
    let created = 0; let assigned = 0;
    for (const name of names) {
        let link = await ctx.store.getLink(ctx.orgId, 'department', name);
        if (!link || !link.gustoUuid) {
            const existing = (await ctx.client.get(`/v1/companies/${cid}/departments`)).find((d) => d.title === name);
            const d = existing || await ctx.client.post(`/v1/companies/${cid}/departments`, { title: name }, { idempotencyKey: `kylrx:${ctx.orgId}:dept:${name}:1` });
            link = await ctx.store.saveLink(ctx.orgId, 'department', name, { gustoUuid: d.uuid, version: d.version, syncState: 'synced' });
            created += 1;
        }
        const members = [];
        for (const p of people.filter((x) => x.department === name)) {
            const pl = await ctx.store.getLink(ctx.orgId, 'employee', p.id);
            if (pl && pl.gustoUuid && (pl.meta || {}).department !== name) members.push({ p, pl });
        }
        if (members.length) {
            await ctx.client.putVersioned(`/v1/departments/${link.gustoUuid}`.replace(/^/, ''), `/v1/departments/${link.gustoUuid}/add`, () => ({ employees: members.map((m) => ({ uuid: m.pl.gustoUuid })) }), { });
            for (const m of members) await ctx.store.saveLink(ctx.orgId, 'employee', m.p.id, { meta: { department: name } });
            assigned += members.length;
        }
    }
    return { departments: names.length, created, assigned };
}

/* ------------------------------- time off ------------------------------- */

async function syncOneTimeOff(ctx, req, empLink) {
    const cid = cidOf(ctx);
    const existing = await ctx.store.getLink(ctx.orgId, 'time_off', req.id);
    if (existing && existing.gustoUuid) return { status: 'unchanged', requestId: req.id };
    try {
        const t = await ctx.client.post(`/v1/companies/${cid}/time_off_requests`, mapping.toGustoTimeOff(req, empLink.gustoUuid), { idempotencyKey: `kylrx:${ctx.orgId}:timeoff:${req.id}` });
        await ctx.store.saveLink(ctx.orgId, 'time_off', req.id, { gustoUuid: t.uuid, version: t.version, syncState: 'synced', userId: req.userId, lastSyncedAt: new Date().toISOString() });
        await ctx.store.resolveErrors(ctx.orgId, 'time_off', req.id);
        return { status: 'synced', requestId: req.id, gustoUuid: t.uuid };
    } catch (e) {
        await ctx.store.logError(ctx.orgId, { scope: 'time_off', ref: req.id, name: req.name || null, code: e.code || 'error', message: errMessage(e) });
        return { status: 'error', requestId: req.id, error: errMessage(e) };
    }
}

/** Approved leave requests -> Gusto time off requests (only for people who are linked). */
async function syncTimeOff(ctx, { ids = null } = {}) {
    const reqs = (await loadLeave(ctx)).filter((r) => r.orgId === ctx.orgId && r.status === 'approved' && (!ids || ids.includes(r.id)));
    const results = [];
    for (const r of reqs) {
        const l = await ctx.store.getLink(ctx.orgId, 'employee', r.userId);
        if (!l || !l.gustoUuid) { results.push({ status: 'skipped', requestId: r.id, reason: 'The person is not in Gusto yet.' }); continue; }
        results.push(await syncOneTimeOff(ctx, r, l));
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    return { total: results.length, synced: count('synced'), unchanged: count('unchanged'), skipped: count('skipped'), errors: count('error'), results };
}

/** Retry whatever an error record points at */
async function retryError(ctx, errorDoc) {
    if (errorDoc.scope === 'person') {
        const p = (await loadPeople(ctx)).find((x) => x.id === errorDoc.ref);
        if (!p) return { status: 'skipped', reason: 'Person not found' };
        return syncPerson(ctx, p, { force: true });
    }
    if (errorDoc.scope === 'time_off') return syncTimeOff(ctx, { ids: [errorDoc.ref] });
    if (errorDoc.scope === 'location') return syncLocations(ctx);
    return { status: 'skipped', reason: 'This kind of error is retried from its own screen.' };
}

module.exports = { stateTaxFor, sendStateTax, loadPeople, syncLocations, syncPerson, syncPeople, pullPeople, syncPaySchedule, syncDepartments, syncTimeOff, retryError };
