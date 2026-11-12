/**
 * Mock Gusto server (in-memory). It follows Gusto's documented API as closely as we know it so the
 * integration can be exercised end to end without partner credentials. It is NOT Gusto: where Gusto's real
 * behaviour is unconfirmed the mock follows our adapter, and docs/GUSTO.md lists those spots.
 *
 * Realism that matters for tests:
 *   - system tokens and company tokens expire; refresh tokens ROTATE (a used refresh token is revoked)
 *   - per-token rate limit with 429 + Retry-After + X-RateLimit-* headers
 *   - PUT needs the object's current `version` (409 otherwise)
 *   - POST idempotency key replays the first response
 *   - webhooks: handshake (verification_token), signed deliveries (X-Gusto-Signature), retries until 2xx
 *   - instant company approval when finish_onboarding is called
 *   - Events API with starting_after_uuid
 * Test-only controls live under /__mock (no auth).
 */
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const rules = require('./rules');

const uuid = () => crypto.randomUUID();
const ver = () => crypto.randomBytes(8).toString('hex');
const tok = () => crypto.randomBytes(24).toString('hex');
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const PAY_PERIODS_PER_YEAR = { 'Every week': 52, 'Every other week': 26, 'Twice per month': 24, Monthly: 12 };

function createMockGusto(options = {}) {
    const cfg = {
        clientId: 'mock-client-id', clientSecret: 'mock-client-secret', tokenTtlSec: 7200, rateMax: 200, rateWindowMs: 60000,
        idempotencyHeader: 'idempotency-key', instantApproval: true, webhookRetryDelayMs: 150, webhookMaxRetries: 16, calcDelayMs: 120, verbose: false,
        ...options
    };
    let S;
    function reset() {
        S = {
            access: new Map(),     // token -> { type:'system'|'company', companyUuid, expiresAt }
            refresh: new Map(),    // token -> { companyUuid, revoked }
            companies: new Map(), locations: new Map(), banks: new Map(), schedules: new Map(), employees: new Map(), homes: new Map(), works: new Map(),
            jobs: new Map(), comps: new Map(), fedTax: new Map(), taxReq: new Map(), signatories: new Map(), forms: new Map(), departments: new Map(),
            payrolls: new Map(), timeOff: new Map(), subs: new Map(), events: [], idem: new Map(), deliveries: [], inject: [], rate: new Map(),
            stats: { requests: 0, systemTokens: 0, refreshes: 0, refreshRejected: 0, rateLimited: 0, conflicts: 0, injected: 0, byPath: {} },
            rateOverride: null
        };
    }
    reset();

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

    const err = (res, status, key, message, metadata) => res.status(status).json({ errors: [{ error_key: key, category: 'api_error', message, ...(metadata ? { metadata } : {}) }] });
    const log = (...a) => { if (cfg.verbose) console.log('[mock-gusto]', ...a); };

    /* ------------------------------- test controls (no auth) ------------------------------- */
    const ctl = express.Router();
    ctl.post('/reset', (req, res) => { reset(); res.json({ ok: true }); });
    ctl.get('/stats', (req, res) => res.json({ ...S.stats, deliveries: S.deliveries.length, events: S.events.length, tokens: S.access.size }));
    ctl.get('/state', (req, res) => {
        const c = req.query.company;
        const pick = (m, f = (x) => x) => [...m.values()].filter((x) => !c || x.company_uuid === c || x.companyUuid === c).map(f);
        res.json({
            companies: pick(S.companies, (x) => ({ uuid: x.uuid, name: x.name, approved: x.approved, onboardingCompleted: x.onboarding_completed, terms: x.terms_accepted })),
            employees: pick(S.employees, ({ ssn, ...e }) => ({ ...e, hasSsn: Boolean(ssn) })), payrolls: pick(S.payrolls), subscriptions: [...S.subs.values()].map((s) => ({ uuid: s.uuid, url: s.url, status: s.status })),
            timeOff: pick(S.timeOff), deliveries: S.deliveries.slice(-50)
        });
    });
    ctl.post('/expire-tokens', (req, res) => {
        let n = 0;
        for (const t of S.access.values()) {
            if ((req.body.system && t.type === 'system') || (req.body.company && t.type === 'company' && (req.body.company === true || t.companyUuid === req.body.company))) { t.expiresAt = Date.now() - 1000; n += 1; }
        }
        res.json({ expired: n });
    });
    ctl.post('/revoke-refresh', (req, res) => { for (const r of S.refresh.values()) r.revoked = true; res.json({ ok: true }); });
    ctl.post('/fail', (req, res) => { S.inject.push({ kind: String(req.body.kind), times: Number(req.body.times || 1), path: req.body.path || null, method: req.body.method || null, retryAfter: req.body.retryAfter || 1 }); res.json({ queued: S.inject.length }); });
    ctl.post('/rate', (req, res) => { S.rateOverride = { max: Number(req.body.max), windowMs: Number(req.body.windowMs || 60000) }; S.rate.clear(); res.json({ ok: true }); });
    ctl.post('/config', (req, res) => { Object.assign(cfg, req.body || {}); res.json({ ok: true }); });
    ctl.get('/deposits', (req, res) => res.json({ deposit_1: 0.12, deposit_2: 0.34 }));
    ctl.post('/event', async (req, res) => {
        const b = req.body || {};
        const evt = emit(b.event_type || 'company.approved', b.company_uuid, { resource_type: b.resource_type || 'Company', resource_uuid: b.resource_uuid || b.company_uuid, entity_type: b.entity_type || b.resource_type || 'Company' }, { quiet: b.quiet === true || b.redeliver === true || b.tamper === true });
        if (b.redeliver || b.tamper) await deliver(evt, { tamper: b.tamper === true, only: b.only });
        res.json({ event: evt });
    });
    ctl.post('/redeliver', async (req, res) => {
        const evt = S.events.find((e) => e.uuid === req.body.uuid);
        if (!evt) return res.status(404).json({ error: 'unknown event' });
        await deliver(evt, { tamper: req.body.tamper === true });
        res.json({ ok: true });
    });
    ctl.post('/payroll-paid', (req, res) => {
        const p = S.payrolls.get(req.body.payroll_uuid);
        if (!p) return res.status(404).json({ error: 'unknown payroll' });
        p.payment_status = 'paid'; p.paid_at = new Date().toISOString();
        emit('payroll.paid', p.company_uuid, { resource_type: 'Payroll', resource_uuid: p.payroll_uuid, entity_type: 'Payroll' });
        res.json({ ok: true });
    });
    app.use('/__mock', ctl);

    /* ------------------------------- auth, rate limit, fault injection ------------------------------- */
    app.use((req, res, next) => {
        S.stats.requests += 1;
        const key = `${req.method} ${req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`;
        S.stats.byPath[key] = (S.stats.byPath[key] || 0) + 1;
        const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        // rate limit per token (or per IP for the token endpoint)
        const id = bearer || req.ip;
        const lim = S.rateOverride || { max: cfg.rateMax, windowMs: cfg.rateWindowMs };
        const now = Date.now();
        const arr = (S.rate.get(id) || []).filter((t) => t > now - lim.windowMs);
        res.set('X-RateLimit-Limit', String(lim.max));
        if (arr.length >= lim.max) {
            S.stats.rateLimited += 1;
            const waitS = Math.max(1, Math.ceil((arr[0] + lim.windowMs - now) / 1000));
            res.set({ 'Retry-After': String(waitS), 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Math.ceil((now + waitS * 1000) / 1000)) });
            return err(res, 429, 'rate_limited', 'Too many requests');
        }
        arr.push(now); S.rate.set(id, arr);
        res.set('X-RateLimit-Remaining', String(lim.max - arr.length));
        // injected faults
        const f = S.inject.find((x) => x.times > 0 && (!x.path || req.path.includes(x.path)) && (!x.method || x.method === req.method));
        if (f) {
            f.times -= 1; S.stats.injected += 1;
            if (f.kind === '429') { res.set('Retry-After', String(f.retryAfter)); S.stats.rateLimited += 1; return err(res, 429, 'rate_limited', 'Injected rate limit'); }
            if (f.kind === '500') return err(res, 500, 'server_error', 'Injected server error');
            if (f.kind === '409') { S.stats.conflicts += 1; return err(res, 409, 'conflict', 'Injected version conflict'); }
            if (f.kind === '401') return err(res, 401, 'unauthorized', 'Injected expiry');
        }
        // idempotent POST replay
        if (req.method === 'POST' && req.headers[cfg.idempotencyHeader]) {
            const k = `${bearer}|${req.path}|${req.headers[cfg.idempotencyHeader]}`;
            const hit = S.idem.get(k);
            if (hit) { res.set('Idempotent-Replayed', 'true'); return res.status(hit.status).json(hit.body); }
            const send = res.json.bind(res);
            res.json = (body) => { if (res.statusCode < 500) S.idem.set(k, { status: res.statusCode, body }); return send(body); };
        }
        req.bearer = bearer;
        next();
    });

    // kind: 'system' | 'company' | 'any'. Company tokens are bound to one company.
    const needs = (kind) => (req, res, next) => {
        const t = S.access.get(req.bearer);
        if (!t || t.expiresAt <= Date.now()) return err(res, 401, 'unauthorized', 'The access token is invalid or expired');
        if (kind !== 'any' && t.type !== kind) return err(res, 403, 'forbidden', `This endpoint needs a ${kind} access token`);
        req.tok = t;
        next();
    };
    const companyOf = (req, res, uuidParam) => {
        const c = S.companies.get(uuidParam);
        if (!c) { err(res, 404, 'not_found', 'Company not found'); return null; }
        if (req.tok.type === 'company' && req.tok.companyUuid !== c.uuid) { err(res, 404, 'not_found', 'Company not found'); return null; }
        return c;
    };
    const asCompany = (path, handler) => [path, needs('company'), (req, res) => { const c = companyOf(req, res, req.params.cid); if (c) return handler(req, res, c); return undefined; }];
    const checkVersion = (req, res, obj) => {
        if (!req.body || req.body.version === undefined || req.body.version !== obj.version) {
            S.stats.conflicts += 1;
            err(res, 409, 'conflict', 'The version you sent is out of date. Re-read the object and try again.');
            return false;
        }
        return true;
    };
    const bump = (o) => { o.version = ver(); return o; };

    /* ------------------------------- OAuth ------------------------------- */
    function issue(type, companyUuid) {
        const access = tok();
        S.access.set(access, { type, companyUuid: companyUuid || null, expiresAt: Date.now() + cfg.tokenTtlSec * 1000 });
        let refresh;
        if (type === 'company') { refresh = tok(); S.refresh.set(refresh, { companyUuid, revoked: false }); }
        return { access_token: access, ...(refresh ? { refresh_token: refresh } : {}), token_type: 'Bearer', expires_in: cfg.tokenTtlSec, created_at: Math.floor(Date.now() / 1000) };
    }
    app.post('/oauth/token', (req, res) => {
        const b = req.body || {};
        if (b.client_id !== cfg.clientId || b.client_secret !== cfg.clientSecret) return err(res, 401, 'invalid_client', 'Client authentication failed');
        if (b.grant_type === 'system_access') { S.stats.systemTokens += 1; return res.json(issue('system')); }
        if (b.grant_type === 'refresh_token') {
            const r = S.refresh.get(b.refresh_token);
            if (!r || r.revoked) { S.stats.refreshRejected += 1; return err(res, 400, 'invalid_grant', 'The refresh token is invalid or was already used'); }
            r.revoked = true; // rotation: the used refresh token dies now
            S.stats.refreshes += 1;
            return res.json(issue('company', r.companyUuid));
        }
        return err(res, 400, 'unsupported_grant_type', 'Unsupported grant_type');
    });

    /* ------------------------------- companies ------------------------------- */
    app.post('/v1/partner_managed_companies', needs('system'), (req, res) => {
        const { user = {}, company = {} } = req.body || {};
        if (!user.first_name || !user.last_name || !user.email || !company.name) return err(res, 422, 'invalid_request', 'user.first_name, user.last_name, user.email and company.name are required');
        const c = { uuid: uuid(), name: company.name, trade_name: company.trade_name || null, ein: company.ein || null, contractor_only: false, admin: user, terms_accepted: false, approved: false, onboarding_completed: false, finished: false, version: ver(), federal: null, industry: null, bankVerified: false };
        S.companies.set(c.uuid, c);
        const t = issue('company', c.uuid);
        res.status(201).json({ company_uuid: c.uuid, access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in });
    });
    app.post('/v1/partner_managed_companies/:cid/accept_terms_of_service', needs('any'), (req, res) => {
        const c = companyOf(req, res, req.params.cid); if (!c) return;
        const b = req.body || {};
        if (!b.email || !b.ip_address || !b.external_user_id) return err(res, 422, 'invalid_request', 'email, ip_address and external_user_id are required');
        c.terms_accepted = true; c.terms = { email: b.email, at: new Date().toISOString() };
        res.json({ latest_terms_accepted: true });
    });
    app.post('/v1/partner_managed_companies/:cid/retrieve_terms_of_service', needs('any'), (req, res) => {
        const c = companyOf(req, res, req.params.cid); if (!c) return;
        res.json({ latest_terms_accepted: c.terms_accepted });
    });
    app.get(...asCompany('/v1/companies/:cid', (req, res, c) => res.json({ uuid: c.uuid, name: c.name, trade_name: c.trade_name, ein: c.ein, company_status: c.approved ? 'Approved' : 'Not Approved', is_suspended: false, version: c.version })));

    /* locations */
    app.post(...asCompany('/v1/companies/:cid/locations', (req, res, c) => {
        const b = req.body || {};
        if (!b.street_1 || !b.city || !b.state || !b.zip) return err(res, 422, 'invalid_request', 'street_1, city, state and zip are required');
        const l = { uuid: uuid(), company_uuid: c.uuid, phone_number: b.phone_number || null, street_1: b.street_1, street_2: b.street_2 || null, city: b.city, state: b.state, zip: b.zip, country: b.country || 'USA', active: true, version: ver() };
        S.locations.set(l.uuid, l);
        res.status(201).json(l);
    }));
    app.get(...asCompany('/v1/companies/:cid/locations', (req, res, c) => res.json([...S.locations.values()].filter((l) => l.company_uuid === c.uuid))));
    app.put('/v1/locations/:id', needs('company'), (req, res) => {
        const l = S.locations.get(req.params.id);
        if (!l || l.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Location not found');
        if (!checkVersion(req, res, l)) return;
        for (const k of ['phone_number', 'street_1', 'street_2', 'city', 'state', 'zip']) if (req.body[k] !== undefined) l[k] = req.body[k];
        res.json(bump(l));
    });

    /* federal tax details and industry */
    app.get(...asCompany('/v1/companies/:cid/federal_tax_details', (req, res, c) => res.json(c.federal || { version: c.version, legal_name: null, has_ein: Boolean(c.ein) })));
    app.put(...asCompany('/v1/companies/:cid/federal_tax_details', (req, res, c) => {
        const cur = c.federal || { version: c.version };
        if (req.body.version !== cur.version) { S.stats.conflicts += 1; return err(res, 409, 'conflict', 'version is out of date'); }
        const b = req.body;
        if (!b.legal_name || !b.tax_payer_type || !b.filing_form) return err(res, 422, 'invalid_request', 'legal_name, tax_payer_type and filing_form are required');
        c.federal = { legal_name: b.legal_name, tax_payer_type: b.tax_payer_type, filing_form: b.filing_form, taxable_as_scorp: Boolean(b.taxable_as_scorp), has_ein: true, version: ver() };
        res.json(c.federal);
    }));
    app.put(...asCompany('/v1/companies/:cid/industry_selection', (req, res, c) => {
        if (!req.body.naics_code && !req.body.title) return err(res, 422, 'invalid_request', 'naics_code or title is required');
        c.industry = { title: req.body.title || null, naics_code: req.body.naics_code || null, sic_codes: req.body.sic_codes || [] };
        res.json({ company_uuid: c.uuid, ...c.industry });
    }));
    app.get(...asCompany('/v1/companies/:cid/industry_selection', (req, res, c) => res.json(c.industry ? { company_uuid: c.uuid, ...c.industry } : { company_uuid: c.uuid, title: null })));

    /* bank accounts (micro-deposit verification) */
    app.post(...asCompany('/v1/companies/:cid/bank_accounts', (req, res, c) => {
        const b = req.body || {};
        if (!/^\d{9}$/.test(String(b.routing_number || '')) || !/^\d{4,17}$/.test(String(b.account_number || ''))) return err(res, 422, 'invalid_request', 'routing_number (9 digits) and account_number are required');
        const a = { uuid: uuid(), company_uuid: c.uuid, account_type: b.account_type || 'Checking', routing_number: b.routing_number, hidden_account_number: `XXXX${String(b.account_number).slice(-4)}`, verification_status: 'awaiting_deposits', verification_type: 'bank_deposits', version: ver() };
        S.banks.set(a.uuid, a);
        res.status(201).json(a);
    }));
    app.get(...asCompany('/v1/companies/:cid/bank_accounts', (req, res, c) => res.json([...S.banks.values()].filter((a) => a.company_uuid === c.uuid))));
    app.put('/v1/companies/:cid/bank_accounts/:bid/verify', needs('company'), (req, res) => {
        const c = companyOf(req, res, req.params.cid); if (!c) return;
        const a = S.banks.get(req.params.bid);
        if (!a || a.company_uuid !== c.uuid) return err(res, 404, 'not_found', 'Bank account not found');
        const { deposit_1: d1, deposit_2: d2 } = req.body || {};
        const ok = [Number(d1), Number(d2)].sort().join() === [0.12, 0.34].join();
        if (!ok) return err(res, 422, 'invalid_deposits', 'The deposit amounts do not match');
        a.verification_status = 'verified'; c.bankVerified = true; bump(a);
        res.json(a);
    });

    /* pay schedules */
    app.post(...asCompany('/v1/companies/:cid/pay_schedules', (req, res, c) => {
        const b = req.body || {};
        if (!PAY_PERIODS_PER_YEAR[b.frequency] || !b.anchor_pay_date || !b.anchor_end_of_pay_period) return err(res, 422, 'invalid_request', 'frequency, anchor_pay_date and anchor_end_of_pay_period are required');
        const s = { uuid: uuid(), company_uuid: c.uuid, frequency: b.frequency, anchor_pay_date: b.anchor_pay_date, anchor_end_of_pay_period: b.anchor_end_of_pay_period, day_1: b.day_1 || null, day_2: b.day_2 || null, name: b.name || b.frequency, active: true, version: ver() };
        S.schedules.set(s.uuid, s);
        res.status(201).json(s);
    }));
    app.get(...asCompany('/v1/companies/:cid/pay_schedules', (req, res, c) => res.json([...S.schedules.values()].filter((s) => s.company_uuid === c.uuid))));
    app.get('/v1/companies/:cid/pay_schedules/:sid', needs('company'), (req, res) => {
        const s = S.schedules.get(req.params.sid);
        if (!s || s.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Pay schedule not found');
        res.json(s);
    });
    app.put('/v1/companies/:cid/pay_schedules/:sid', needs('company'), (req, res) => {
        const s = S.schedules.get(req.params.sid);
        if (!s || s.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Pay schedule not found');
        if (!checkVersion(req, res, s)) return;
        for (const k of ['frequency', 'anchor_pay_date', 'anchor_end_of_pay_period', 'day_1', 'day_2', 'name']) if (req.body[k] !== undefined) s[k] = req.body[k];
        res.json(bump(s));
    });

    /* employees */
    const pubEmp = (e) => { const { ssn, ...rest } = e; return { ...rest, has_ssn: Boolean(ssn), jobs: [...S.jobs.values()].filter((j) => j.employee_uuid === e.uuid).map(pubJob) }; };
    const pubJob = (j) => ({ ...j, compensations: [...S.comps.values()].filter((c) => c.job_uuid === j.uuid) });
    app.post(...asCompany('/v1/companies/:cid/employees', (req, res, c) => {
        const b = req.body || {};
        if (!b.first_name || !b.last_name) return err(res, 422, 'invalid_request', 'first_name and last_name are required');
        if (b.email && [...S.employees.values()].some((e) => e.company_uuid === c.uuid && e.email === b.email && !e.terminated)) return err(res, 422, 'duplicate_email', 'An employee with this email already exists');
        const e = { uuid: uuid(), company_uuid: c.uuid, first_name: b.first_name, middle_initial: b.middle_initial || '', last_name: b.last_name, email: b.email || null, date_of_birth: b.date_of_birth || null, ssn: b.ssn || null, onboarded: false, onboarding_status: 'admin_onboarding_incomplete', terminated: false, current_employment_status: 'full_time', department_uuid: null, payment_method: 'Check', version: ver() };
        S.employees.set(e.uuid, e);
        emit('employee.created', c.uuid, { resource_type: 'Employee', resource_uuid: e.uuid, entity_type: 'Employee' });
        res.status(201).json(pubEmp(e));
    }));
    app.get(...asCompany('/v1/companies/:cid/employees', (req, res, c) => {
        const all = [...S.employees.values()].filter((e) => e.company_uuid === c.uuid);
        const per = Math.max(1, Math.min(100, Number(req.query.per) || 25));
        const page = Math.max(1, Number(req.query.page) || 1);
        res.set({ 'X-Total-Count': String(all.length), 'X-Total-Pages': String(Math.max(1, Math.ceil(all.length / per))) });
        res.json(all.slice((page - 1) * per, page * per).map(pubEmp));
    }));
    const empFor = (req, res) => {
        const e = S.employees.get(req.params.id);
        if (!e || e.company_uuid !== req.tok.companyUuid) { err(res, 404, 'not_found', 'Employee not found'); return null; }
        return e;
    };
    app.get('/v1/employees/:id', needs('company'), (req, res) => { const e = empFor(req, res); if (e) res.json(pubEmp(e)); });
    app.put('/v1/employees/:id', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        if (!checkVersion(req, res, e)) return;
        for (const k of ['first_name', 'middle_initial', 'last_name', 'email', 'date_of_birth', 'ssn']) if (req.body[k] !== undefined) e[k] = req.body[k];
        bump(e);
        emit('employee.updated', e.company_uuid, { resource_type: 'Employee', resource_uuid: e.uuid, entity_type: 'Employee' }, { quiet: true });
        res.json(pubEmp(e));
    });
    app.post('/v1/employees/:id/home_addresses', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        const b = req.body || {};
        if (!b.street_1 || !b.city || !b.state || !b.zip) return err(res, 422, 'invalid_request', 'street_1, city, state and zip are required');
        const h = { uuid: uuid(), employee_uuid: e.uuid, street_1: b.street_1, street_2: b.street_2 || null, city: b.city, state: b.state, zip: b.zip, effective_date: b.effective_date || null, active: true, version: ver() };
        S.homes.set(h.uuid, h);
        res.status(201).json(h);
    });
    app.get('/v1/employees/:id/home_addresses', needs('company'), (req, res) => { const e = empFor(req, res); if (e) res.json([...S.homes.values()].filter((h) => h.employee_uuid === e.uuid)); });
    app.put('/v1/home_addresses/:hid', needs('company'), (req, res) => {
        const h = S.homes.get(req.params.hid);
        const e = h && S.employees.get(h.employee_uuid);
        if (!h || !e || e.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Address not found');
        if (!checkVersion(req, res, h)) return;
        for (const k of ['street_1', 'street_2', 'city', 'state', 'zip']) if (req.body[k] !== undefined) h[k] = req.body[k];
        res.json(bump(h));
    });
    app.post('/v1/employees/:id/work_addresses', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        const loc = S.locations.get((req.body || {}).location_uuid);
        if (!loc || loc.company_uuid !== e.company_uuid) return err(res, 422, 'invalid_location', 'location_uuid does not belong to this company');
        const w = { uuid: uuid(), employee_uuid: e.uuid, location_uuid: loc.uuid, effective_date: req.body.effective_date || null, active: true, version: ver() };
        S.works.set(w.uuid, w);
        res.status(201).json(w);
    });
    app.post('/v1/employees/:id/jobs', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        const b = req.body || {};
        if (!b.title || !b.hire_date) return err(res, 422, 'invalid_request', 'title and hire_date are required');
        const j = { uuid: uuid(), employee_uuid: e.uuid, title: b.title, hire_date: b.hire_date, primary: ![...S.jobs.values()].some((x) => x.employee_uuid === e.uuid), version: ver() };
        S.jobs.set(j.uuid, j);
        const cmp = { uuid: uuid(), job_uuid: j.uuid, rate: '0.00', payment_unit: 'Hour', flsa_status: 'Nonexempt', effective_date: b.hire_date, version: ver() };
        S.comps.set(cmp.uuid, cmp);
        j.current_compensation_uuid = cmp.uuid;
        res.status(201).json(pubJob(j));
    });
    app.put('/v1/jobs/:jid', needs('company'), (req, res) => {
        const j = S.jobs.get(req.params.jid);
        const e = j && S.employees.get(j.employee_uuid);
        if (!j || !e || e.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Job not found');
        if (!checkVersion(req, res, j)) return;
        for (const k of ['title', 'hire_date']) if (req.body[k] !== undefined) j[k] = req.body[k];
        res.json(pubJob(bump(j)));
    });
    app.get('/v1/employees/:id/jobs', needs('company'), (req, res) => { const e = empFor(req, res); if (e) res.json([...S.jobs.values()].filter((j) => j.employee_uuid === e.uuid).map(pubJob)); });
    app.put('/v1/compensations/:kid', needs('company'), (req, res) => {
        const k = S.comps.get(req.params.kid);
        const j = k && S.jobs.get(k.job_uuid);
        const e = j && S.employees.get(j.employee_uuid);
        if (!k || !e || e.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Compensation not found');
        if (!checkVersion(req, res, k)) return;
        const b = req.body;
        if (b.payment_unit !== undefined && !['Hour', 'Week', 'Month', 'Year', 'Paycheck'].includes(b.payment_unit)) return err(res, 422, 'invalid_request', 'payment_unit is not valid');
        for (const f of ['rate', 'payment_unit', 'flsa_status']) if (b[f] !== undefined) k[f] = String(b[f]);
        res.json(bump(k));
    });
    // The empty record is created once and kept, so the version a client reads is the version its PUT must send.
    const fedTaxOf = (e) => {
        if (!S.fedTax.has(e.uuid)) S.fedTax.set(e.uuid, { employee_uuid: e.uuid, filing_status: null, version: ver(), w4_data_type: 'rev_2020_w4' });
        return S.fedTax.get(e.uuid);
    };
    app.get('/v1/employees/:id/federal_taxes', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        res.json(fedTaxOf(e));
    });
    app.put('/v1/employees/:id/federal_taxes', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        const cur = fedTaxOf(e);
        if (req.body.version !== cur.version) { S.stats.conflicts += 1; return err(res, 409, 'conflict', 'version is out of date'); }
        if (req.body.filing_status !== undefined && !['Single', 'Married', 'Head of Household', 'Exempt from withholding'].includes(req.body.filing_status)) return err(res, 422, 'invalid_request', 'filing_status is not valid');
        const next = { ...cur, ...req.body, employee_uuid: e.uuid, version: ver() };
        S.fedTax.set(e.uuid, next);
        res.json(next);
    });
    app.put('/v1/employees/:id/onboarding_status', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        const target = (req.body || {}).onboarding_status;
        if (target !== 'onboarding_completed') { e.onboarding_status = target || e.onboarding_status; return res.json({ uuid: e.uuid, onboarding_status: e.onboarding_status }); }
        const missing = [];
        if (![...S.homes.values()].some((h) => h.employee_uuid === e.uuid)) missing.push('home_address');
        if (![...S.works.values()].some((w) => w.employee_uuid === e.uuid)) missing.push('work_address');
        const job = [...S.jobs.values()].find((j) => j.employee_uuid === e.uuid);
        if (!job || !(Number([...S.comps.values()].find((k) => k.job_uuid === job.uuid).rate) > 0)) missing.push('compensation');
        if (!S.fedTax.get(e.uuid) || !S.fedTax.get(e.uuid).filing_status) missing.push('federal_taxes');
        if (missing.length) return err(res, 422, 'onboarding_incomplete', `Employee is missing: ${missing.join(', ')}`, { missing });
        e.onboarded = true; e.onboarding_status = 'onboarding_completed'; bump(e);
        res.json({ uuid: e.uuid, onboarding_status: e.onboarding_status, onboarding_steps: [] });
    });
    app.put('/v1/employees/:id/payment_method', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        if (!checkVersion(req, res, { version: e.pm_version || e.version })) return;
        e.payment_method = (req.body || {}).type || e.payment_method;
        res.json({ type: e.payment_method, version: e.pm_version || e.version });
    });

    /* single-object reads (used by versioned updates) */
    const ownedBy = (res, req, obj, companyUuid) => { if (!obj || companyUuid !== req.tok.companyUuid) { err(res, 404, 'not_found', 'Not found'); return false; } return true; };
    app.get('/v1/locations/:id', needs('company'), (req, res) => { const l = S.locations.get(req.params.id); if (ownedBy(res, req, l, l && l.company_uuid)) res.json(l); });
    app.get('/v1/home_addresses/:id', needs('company'), (req, res) => { const h = S.homes.get(req.params.id); const e = h && S.employees.get(h.employee_uuid); if (ownedBy(res, req, h, e && e.company_uuid)) res.json(h); });
    app.get('/v1/jobs/:id', needs('company'), (req, res) => { const j = S.jobs.get(req.params.id); const e = j && S.employees.get(j.employee_uuid); if (ownedBy(res, req, j, e && e.company_uuid)) res.json(pubJob(j)); });
    app.get('/v1/compensations/:id', needs('company'), (req, res) => { const k = S.comps.get(req.params.id); const j = k && S.jobs.get(k.job_uuid); const e = j && S.employees.get(j.employee_uuid); if (ownedBy(res, req, k, e && e.company_uuid)) res.json(k); });
    app.get('/v1/departments/:id', needs('company'), (req, res) => { const d = S.departments.get(req.params.id); if (ownedBy(res, req, d, d && d.company_uuid)) res.json(d); });

    /* departments */
    app.post(...asCompany('/v1/companies/:cid/departments', (req, res, c) => {
        if (!(req.body || {}).title) return err(res, 422, 'invalid_request', 'title is required');
        const d = { uuid: uuid(), company_uuid: c.uuid, title: req.body.title, version: ver(), employees: [] };
        S.departments.set(d.uuid, d);
        res.status(201).json(d);
    }));
    app.get(...asCompany('/v1/companies/:cid/departments', (req, res, c) => res.json([...S.departments.values()].filter((d) => d.company_uuid === c.uuid))));
    app.put('/v1/departments/:did/add', needs('company'), (req, res) => {
        const d = S.departments.get(req.params.did);
        if (!d || d.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Department not found');
        if (!checkVersion(req, res, d)) return;
        for (const x of (req.body.employees || [])) { const e = S.employees.get(x.uuid); if (e && e.company_uuid === d.company_uuid) { e.department_uuid = d.uuid; if (!d.employees.includes(e.uuid)) d.employees.push(e.uuid); } }
        res.json(bump(d));
    });

    /* state tax requirements */
    const statesOf = (c) => [...new Set([...S.locations.values()].filter((l) => l.company_uuid === c.uuid).map((l) => l.state))];
    const taxReq = (c, st) => {
        if (!S.taxReq.has(c.uuid)) S.taxReq.set(c.uuid, new Map());
        const m = S.taxReq.get(c.uuid);
        if (!m.has(st)) m.set(st, { state: st, setup_complete: false, version: ver(), requirement_sets: [{ key: 'registrations', label: 'State registrations', state: st, requirements: [{ key: 'state_tax_id', label: 'State tax account number', value: null }, { key: 'sui_rate', label: 'Unemployment insurance rate (%)', value: null }] }] });
        return m.get(st);
    };
    app.get(...asCompany('/v1/companies/:cid/tax_requirements', (req, res, c) => res.json(statesOf(c).map((st) => { const t = taxReq(c, st); return { state: st, setup_complete: t.setup_complete }; }))));
    app.get('/v1/companies/:cid/tax_requirements/:state', needs('company'), (req, res) => { const c = companyOf(req, res, req.params.cid); if (c) res.json(taxReq(c, req.params.state)); });
    app.put('/v1/companies/:cid/tax_requirements/:state', needs('company'), (req, res) => {
        const c = companyOf(req, res, req.params.cid); if (!c) return;
        const t = taxReq(c, req.params.state);
        if (req.body.version !== t.version) { S.stats.conflicts += 1; return err(res, 409, 'conflict', 'version is out of date'); }
        for (const set of (req.body.requirement_sets || [])) for (const r of (set.requirements || [])) {
            const tgt = t.requirement_sets[0].requirements.find((x) => x.key === r.key);
            if (tgt) tgt.value = r.value;
        }
        t.setup_complete = t.requirement_sets[0].requirements.every((r) => r.value !== null && r.value !== '');
        t.version = ver();
        res.json(t);
    });

    /* signatory and forms */
    app.post(...asCompany('/v1/companies/:cid/signatories', (req, res, c) => {
        const b = req.body || {};
        if (!b.first_name || !b.last_name || !b.email || !b.title) return err(res, 422, 'invalid_request', 'first_name, last_name, email and title are required');
        const s = { uuid: uuid(), company_uuid: c.uuid, first_name: b.first_name, last_name: b.last_name, email: b.email, title: b.title, version: ver() };
        S.signatories.set(c.uuid, s);
        for (const [name, title] of [['form_8655', 'Authorization for Gusto to file and pay taxes (Form 8655)'], ['company_efile', 'Federal e-file and e-pay authorisation']]) {
            const f = { uuid: uuid(), company_uuid: c.uuid, name, title, requires_signing: true, signed: false, document_type: 'pdf' };
            S.forms.set(f.uuid, f);
        }
        res.status(201).json(s);
    }));
    app.get(...asCompany('/v1/companies/:cid/signatories', (req, res, c) => res.json(S.signatories.has(c.uuid) ? [S.signatories.get(c.uuid)] : [])));
    app.get(...asCompany('/v1/companies/:cid/forms', (req, res, c) => res.json([...S.forms.values()].filter((f) => f.company_uuid === c.uuid))));
    app.put('/v1/forms/:fid/sign', needs('company'), (req, res) => {
        const f = S.forms.get(req.params.fid);
        if (!f || f.company_uuid !== req.tok.companyUuid) return err(res, 404, 'not_found', 'Form not found');
        const b = req.body || {};
        if (!b.signature_text || b.agree !== true) return err(res, 422, 'invalid_request', 'signature_text and agree=true are required');
        f.signed = true; f.signed_at = new Date().toISOString(); f.signed_by = b.signature_text;
        res.json(f);
    });

    /* onboarding status and finish */
    const onboardingSteps = (c) => {
        const emps = [...S.employees.values()].filter((e) => e.company_uuid === c.uuid);
        const states = statesOf(c);
        const forms = [...S.forms.values()].filter((f) => f.company_uuid === c.uuid);
        const mk = (id, title, completed, requirements = []) => ({ id, title, required: true, completed, requirements });
        return [
            mk('add_addresses', 'Add addresses', statesOf(c).length > 0),
            mk('federal_tax_setup', 'Federal tax setup', Boolean(c.federal)),
            mk('select_industry', 'Select industry', Boolean(c.industry)),
            mk('add_bank_info', 'Add bank info', [...S.banks.values()].some((b) => b.company_uuid === c.uuid && b.verification_status === 'verified')),
            mk('add_employees', 'Add employees', emps.some((e) => e.onboarded)),
            mk('state_setup', 'State setup', states.length > 0 && states.every((s) => taxReq(c, s).setup_complete)),
            mk('payroll_schedule', 'Payroll schedule', [...S.schedules.values()].some((s) => s.company_uuid === c.uuid)),
            mk('sign_all_forms', 'Sign documents', S.signatories.has(c.uuid) && forms.length > 0 && forms.every((f) => f.signed))
        ];
    };
    app.get(...asCompany('/v1/companies/:cid/onboarding_status', (req, res, c) => {
        const steps = onboardingSteps(c);
        res.json({ uuid: c.uuid, onboarding_completed: c.onboarding_completed, onboarding_steps: steps });
    }));
    app.put(...asCompany('/v1/companies/:cid/finish_onboarding', (req, res, c) => {
        const open = onboardingSteps(c).filter((s) => !s.completed);
        if (!c.terms_accepted) open.unshift({ id: 'accept_terms', title: 'Accept terms' });
        if (open.length) return err(res, 422, 'onboarding_incomplete', `Steps not finished: ${open.map((s) => s.id).join(', ')}`, { steps: open.map((s) => s.id) });
        c.finished = true;
        res.json({ uuid: c.uuid, onboarding_completed: true, onboarding_status: cfg.instantApproval ? 'approved' : 'under_review' });
        if (cfg.instantApproval) approve(c);
    }));
    function approve(c) {
        c.approved = true; c.onboarding_completed = true;
        emit('company.approved', c.uuid, { resource_type: 'Company', resource_uuid: c.uuid, entity_type: 'Company' });
    }

    /* ------------------------------- payrolls ------------------------------- */
    function generatePayrolls(c) {
        for (const s of [...S.schedules.values()].filter((x) => x.company_uuid === c.uuid)) {
            const gap = Date.parse(`${s.anchor_pay_date}T00:00:00Z`) - Date.parse(`${s.anchor_end_of_pay_period}T00:00:00Z`);
            const lagDays = Math.round(gap / 86400000);
            const days = s.frequency === 'Every week' ? 7 : s.frequency === 'Every other week' ? 14 : null;
            if (!days) continue; // semimonthly/monthly periods are created through /__mock/payroll in tests
            let end = s.anchor_end_of_pay_period;
            while (end > addDays(isoOf(new Date()), -400)) end = addDays(end, -days);
            while (end < addDays(isoOf(new Date()), 120)) {
                end = addDays(end, days);
                const start = addDays(end, -(days - 1));
                if ([...S.payrolls.values()].some((p) => p.company_uuid === c.uuid && p.pay_period.start_date === start && p.pay_period.end_date === end)) continue;
                makePayroll(c, s, start, end, addDays(end, lagDays));
            }
        }
    }
    function makePayroll(c, s, start, end, checkDate) {
        const p = {
            payroll_uuid: uuid(), company_uuid: c.uuid, payroll_type: 'regular', off_cycle: false, processed: false, version: ver(), check_date: checkDate,
            payroll_deadline: rules.pacificDeadlineIso(rules.subBusinessDays(checkDate, 4)), pay_period: { start_date: start, end_date: end, pay_schedule_uuid: s ? s.uuid : null },
            employee_compensations: [], totals: null, processing_request: null, calculated_at: null, prepared: false, pay_schedule_frequency: s ? s.frequency : 'Every other week'
        };
        S.payrolls.set(p.payroll_uuid, p);
        return p;
    }
    const settle = (p) => {
        if (p.processing_request && p.processing_request.status === 'calculating' && Date.now() - p.processing_request.startedAt >= cfg.calcDelayMs) calculate(p);
    };
    const pubPayroll = (p, c, includeTotals = true) => { settle(p); const { prepared, pay_schedule_frequency, ...rest } = p; return { ...rest, processing_request: p.processing_request ? { status: p.processing_request.status } : null, ...(includeTotals ? {} : { totals: undefined }), submission_blockers: blockersOf(c || S.companies.get(p.company_uuid)) }; };
    function blockersOf(c) {
        const out = [];
        if (!c.approved) out.push({ key: 'needs_approved_company', message: 'The company is not approved by Gusto yet' });
        if (![...S.employees.values()].some((e) => e.company_uuid === c.uuid && e.onboarded)) out.push({ key: 'needs_onboarded_employees', message: 'At least one employee must finish onboarding' });
        if (![...S.banks.values()].some((b) => b.company_uuid === c.uuid && b.verification_status === 'verified')) out.push({ key: 'needs_verified_bank_account', message: 'The bank account is not verified' });
        return out;
    }
    function calculate(p) {
        const factor = PAY_PERIODS_PER_YEAR[p.pay_schedule_frequency] || 26;
        let gross = 0;
        for (const ec of p.employee_compensations) {
            if (ec.excluded) { ec.gross_pay = '0.00'; ec.net_pay = '0.00'; continue; }
            let g = 0;
            const job = [...S.jobs.values()].find((j) => j.employee_uuid === ec.employee_uuid);
            const cmp = job && [...S.comps.values()].find((k) => k.job_uuid === job.uuid);
            if (cmp) {
                const rate = Number(cmp.rate) || 0;
                if (cmp.payment_unit === 'Hour') g += (ec.hourly_compensations || []).reduce((a, h) => a + rate * Number(h.hours || 0) * Number(h.compensation_multiplier || 1), 0) + (ec.paid_time_off || []).reduce((a, h) => a + rate * Number(h.hours || 0), 0);
                else g += cmp.payment_unit === 'Year' ? rate / factor : cmp.payment_unit === 'Month' ? rate * 12 / factor : rate;
            }
            g += (ec.fixed_compensations || []).reduce((a, f) => a + Number(f.amount || 0), 0);
            ec.gross_pay = money(g); ec.net_pay = money(g * 0.8);
            gross += g;
        }
        p.totals = { gross_pay: money(gross), net_pay: money(gross * 0.8), employee_taxes: money(gross * 0.2), employer_taxes: money(gross * 0.08), company_debit: money(gross * 1.08), employee_bonuses: '0.00', reimbursements: '0.00', benefits: '0.00' };
        p.processing_request = { status: 'calculate_success' };
        p.calculated_at = new Date().toISOString();
        emit('payroll.calculated', p.company_uuid, { resource_type: 'Payroll', resource_uuid: p.payroll_uuid, entity_type: 'Payroll' }, { quiet: true });
    }
    const payrollFor = (req, res, c) => {
        const p = S.payrolls.get(req.params.pid);
        if (!p || p.company_uuid !== c.uuid) { err(res, 404, 'not_found', 'Payroll not found'); return null; }
        return p;
    };
    app.get(...asCompany('/v1/companies/:cid/payrolls/blockers', (req, res, c) => res.json(blockersOf(c))));
    app.get(...asCompany('/v1/companies/:cid/payrolls', (req, res, c) => {
        generatePayrolls(c);
        let rows = [...S.payrolls.values()].filter((p) => p.company_uuid === c.uuid);
        const q = req.query;
        const statuses = String(q.processing_statuses || '').split(',').filter(Boolean);
        if (statuses.length) rows = rows.filter((p) => (statuses.includes('processed') ? p.processed : false) || (statuses.includes('unprocessed') ? !p.processed : false));
        if (q.start_date) rows = rows.filter((p) => p.pay_period.end_date >= q.start_date);
        if (q.end_date) rows = rows.filter((p) => p.pay_period.start_date <= q.end_date);
        rows.sort((a, b) => a.pay_period.start_date.localeCompare(b.pay_period.start_date));
        const per = Math.max(1, Math.min(100, Number(q.per) || 25)); const page = Math.max(1, Number(q.page) || 1);
        res.set('X-Total-Pages', String(Math.max(1, Math.ceil(rows.length / per))));
        res.json(rows.slice((page - 1) * per, page * per).map((p) => pubPayroll(p, c)));
    }));
    app.get(...asCompany('/v1/companies/:cid/payrolls/:pid', (req, res, c) => { const p = payrollFor(req, res, c); if (p) res.json(pubPayroll(p, c)); }));
    app.put(...asCompany('/v1/companies/:cid/payrolls/:pid/prepare', (req, res, c) => {
        const p = payrollFor(req, res, c); if (!p) return;
        if (p.processed) return err(res, 422, 'already_processed', 'This payroll is already processed');
        p.employee_compensations = [...S.employees.values()].filter((e) => e.company_uuid === c.uuid && e.onboarded && !e.terminated).map((e) => {
            const job = [...S.jobs.values()].find((j) => j.employee_uuid === e.uuid);
            const cmp = job && [...S.comps.values()].find((k) => k.job_uuid === job.uuid);
            const hourly = cmp && cmp.payment_unit === 'Hour';
            const existing = p.employee_compensations.find((x) => x.employee_uuid === e.uuid);
            return existing || {
                employee_uuid: e.uuid, excluded: false, version: ver(), payment_method: e.payment_method,
                fixed_compensations: hourly ? [] : [{ name: 'Regular Wages', amount: '0.00', job_uuid: job && job.uuid }],
                hourly_compensations: hourly ? [{ name: 'Regular Hours', hours: '0.000', job_uuid: job.uuid, compensation_multiplier: 1 }, { name: 'Overtime', hours: '0.000', job_uuid: job.uuid, compensation_multiplier: 1.5 }, { name: 'Double overtime', hours: '0.000', job_uuid: job.uuid, compensation_multiplier: 2 }] : [],
                paid_time_off: []
            };
        });
        p.prepared = true; bump(p);
        res.json(pubPayroll(p, c));
    }));
    app.put(...asCompany('/v1/companies/:cid/payrolls/:pid', (req, res, c) => {
        const p = payrollFor(req, res, c); if (!p) return;
        if (p.processed) return err(res, 422, 'already_processed', 'This payroll is already processed');
        if (!p.prepared) return err(res, 422, 'not_prepared', 'Prepare the payroll before updating it');
        if (!checkVersion(req, res, p)) return;
        for (const upd of (req.body.employee_compensations || [])) {
            const ec = p.employee_compensations.find((x) => x.employee_uuid === upd.employee_uuid);
            if (!ec) return err(res, 422, 'unknown_employee', 'employee_uuid is not part of this payroll', { employee_uuid: upd.employee_uuid });
            if (upd.hourly_compensations) ec.hourly_compensations = upd.hourly_compensations;
            if (upd.paid_time_off) ec.paid_time_off = upd.paid_time_off;
            if (upd.fixed_compensations) ec.fixed_compensations = upd.fixed_compensations;
            if (upd.excluded !== undefined) ec.excluded = upd.excluded;
        }
        p.totals = null; p.processing_request = null; p.calculated_at = null;
        bump(p);
        res.json(pubPayroll(p, c));
    }));
    app.put(...asCompany('/v1/companies/:cid/payrolls/:pid/calculate', (req, res, c) => {
        const p = payrollFor(req, res, c); if (!p) return;
        if (!p.prepared) return err(res, 422, 'not_prepared', 'Prepare the payroll first');
        if (p.processed) return err(res, 422, 'already_processed', 'This payroll is already processed');
        p.processing_request = { status: 'calculating', startedAt: Date.now() };
        res.status(202).json({ payroll_uuid: p.payroll_uuid, processing_request: { status: 'calculating' } });
    }));
    app.put(...asCompany('/v1/companies/:cid/payrolls/:pid/submit', (req, res, c) => {
        const p = payrollFor(req, res, c); if (!p) return;
        settle(p);
        if (p.processed) return err(res, 422, 'already_processed', 'This payroll is already submitted');
        const blockers = blockersOf(c);
        if (blockers.length) return err(res, 422, 'submission_blockers', blockers.map((b) => b.message).join('; '), { blockers });
        if (!p.totals) return err(res, 422, 'not_calculated', 'Calculate the payroll before submitting it');
        p.processed = true; p.processing_request = { status: 'submit_success' }; p.submitted_at = new Date().toISOString(); bump(p);
        emit('payroll.submitted', c.uuid, { resource_type: 'Payroll', resource_uuid: p.payroll_uuid, entity_type: 'Payroll' });
        res.status(202).json({ payroll_uuid: p.payroll_uuid, processing_request: { status: 'submit_success' } });
    }));
    app.put(...asCompany('/v1/companies/:cid/payrolls/:pid/cancel', (req, res, c) => {
        const p = payrollFor(req, res, c); if (!p) return;
        if (!p.processed) return err(res, 422, 'not_processed', 'Only a submitted payroll can be cancelled; an unsubmitted one is simply not run');
        p.processed = false; p.prepared = false; p.totals = null; p.processing_request = null; p.employee_compensations = []; p.cancelled_at = new Date().toISOString(); bump(p);
        emit('payroll.cancelled', c.uuid, { resource_type: 'Payroll', resource_uuid: p.payroll_uuid, entity_type: 'Payroll' });
        res.json(pubPayroll(p, c));
    }));
    app.get('/v1/payrolls/:pid/receipt', needs('company'), (req, res) => {
        const p = S.payrolls.get(req.params.pid);
        if (!p || p.company_uuid !== req.tok.companyUuid || !p.processed) return err(res, 404, 'not_found', 'Receipt not found');
        res.json({ payroll_uuid: p.payroll_uuid, company_uuid: p.company_uuid, check_date: p.check_date, totals: p.totals, employee_compensations: p.employee_compensations.map((e) => ({ employee_uuid: e.employee_uuid, gross_pay: e.gross_pay, net_pay: e.net_pay })), submitted_at: p.submitted_at });
    });
    app.get('/v1/employees/:id/pay_stubs', needs('company'), (req, res) => {
        const e = empFor(req, res); if (!e) return;
        const rows = [...S.payrolls.values()].filter((p) => p.processed && p.company_uuid === e.company_uuid).map((p) => { const ec = p.employee_compensations.find((x) => x.employee_uuid === e.uuid); return ec && { payroll_uuid: p.payroll_uuid, check_date: p.check_date, pay_period: p.pay_period, gross_pay: ec.gross_pay, net_pay: ec.net_pay }; }).filter(Boolean);
        res.json(rows);
    });
    app.get(...asCompany('/v1/companies/:cid/tax_liabilities', (req, res, c) => res.json([...S.payrolls.values()].filter((p) => p.processed && p.company_uuid === c.uuid).flatMap((p) => [
        { payroll_uuid: p.payroll_uuid, tax_name: 'Federal income tax withholding', amount: p.totals.employee_taxes, status: 'scheduled', due_date: p.check_date },
        { payroll_uuid: p.payroll_uuid, tax_name: 'Employer taxes', amount: p.totals.employer_taxes, status: 'scheduled', due_date: p.check_date }
    ]))));

    /* time off (path and shape are our adapter's best guess; see docs) */
    app.post(...asCompany('/v1/companies/:cid/time_off_requests', (req, res, c) => {
        const b = req.body || {};
        const e = S.employees.get(b.employee_uuid);
        if (!e || e.company_uuid !== c.uuid) return err(res, 422, 'unknown_employee', 'employee_uuid is not in this company');
        if (!b.start_date || !b.end_date || !(Number(b.hours) > 0)) return err(res, 422, 'invalid_request', 'start_date, end_date and hours are required');
        const t = { uuid: uuid(), company_uuid: c.uuid, employee_uuid: e.uuid, policy_type: b.policy_type || 'vacation', start_date: b.start_date, end_date: b.end_date, hours: String(b.hours), status: b.status || 'approved', external_id: b.external_id || null, version: ver() };
        S.timeOff.set(t.uuid, t);
        emit('time_off_request.created', c.uuid, { resource_type: 'TimeOffRequest', resource_uuid: t.uuid, entity_type: 'TimeOffRequest' }, { quiet: true });
        res.status(201).json(t);
    }));
    app.get(...asCompany('/v1/companies/:cid/time_off_requests', (req, res, c) => res.json([...S.timeOff.values()].filter((t) => t.company_uuid === c.uuid))));

    /* ------------------------------- webhooks + events ------------------------------- */
    app.post('/v1/webhook_subscriptions', needs('system'), (req, res) => {
        const b = req.body || {};
        if (!/^https?:\/\//.test(String(b.url || '')) || !Array.isArray(b.subscription_types) || !b.subscription_types.length) return err(res, 422, 'invalid_request', 'url and subscription_types are required');
        const s = { uuid: uuid(), url: b.url, subscription_types: b.subscription_types, status: 'pending', verification_token: tok() };
        S.subs.set(s.uuid, s);
        res.status(201).json({ uuid: s.uuid, url: s.url, subscription_types: s.subscription_types, status: s.status });
        // handshake: Gusto posts the verification_token to the URL; the receiver then calls PUT .../verify
        setTimeout(() => {
            fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'webhook_subscription.verification', subscription_uuid: s.uuid, verification_token: s.verification_token }) }).catch(() => {});
        }, 30);
    });
    app.get('/v1/webhook_subscriptions', needs('system'), (req, res) => res.json([...S.subs.values()].map(({ verification_token, ...s }) => s)));
    app.get('/v1/webhook_subscriptions/:sid', needs('system'), (req, res) => { const s = S.subs.get(req.params.sid); if (!s) return err(res, 404, 'not_found', 'Subscription not found'); const { verification_token, ...rest } = s; res.json(rest); });
    app.put('/v1/webhook_subscriptions/:sid/verify', needs('system'), (req, res) => {
        const s = S.subs.get(req.params.sid);
        if (!s) return err(res, 404, 'not_found', 'Subscription not found');
        if ((req.body || {}).verification_token !== s.verification_token) return err(res, 422, 'invalid_token', 'verification_token does not match');
        s.status = 'verified';
        const { verification_token, ...rest } = s; res.json(rest);
    });
    app.delete('/v1/webhook_subscriptions/:sid', needs('system'), (req, res) => { S.subs.delete(req.params.sid); res.status(204).end(); });
    app.get('/v1/events', needs('any'), (req, res) => {
        let rows = S.events;
        if (req.tok.type === 'company') rows = rows.filter((e) => e.company_uuid === req.tok.companyUuid);
        else if (req.query.company_uuid) rows = rows.filter((e) => e.company_uuid === req.query.company_uuid);
        if (req.query.event_type) rows = rows.filter((e) => e.event_type === req.query.event_type);
        if (req.query.starting_after_uuid) { const i = rows.findIndex((e) => e.uuid === req.query.starting_after_uuid); if (i >= 0) rows = rows.slice(i + 1); }
        res.json(rows.slice(0, Math.min(Number(req.query.limit) || 100, 100)));
    });

    function emit(eventType, companyUuid, extra = {}, { quiet = false } = {}) {
        const evt = { uuid: uuid(), event_type: eventType, resource_type: extra.resource_type, resource_uuid: extra.resource_uuid, entity_type: extra.entity_type || extra.resource_type, entity_uuid: extra.resource_uuid, company_uuid: companyUuid, timestamp: Math.floor(Date.now() / 1000) };
        S.events.push(evt);
        if (!quiet) deliver(evt).catch(() => {});
        return evt;
    }
    function sign(body, token) { return rules.signPayload(body, token); }
    async function deliver(evt, { tamper = false, only = null } = {}) {
        const body = JSON.stringify(evt);
        const subs = [...S.subs.values()].filter((s) => s.status === 'verified' && s.subscription_types.map((t) => t.toLowerCase()).includes(String(evt.entity_type).toLowerCase()) && (!only || s.uuid === only));
        await Promise.all(subs.map(async (s) => {
            for (let attempt = 1; attempt <= cfg.webhookMaxRetries; attempt += 1) {
                let status = 0;
                try {
                    const ctl2 = new AbortController(); const timer = setTimeout(() => ctl2.abort(), 10000);
                    const r = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gusto-Signature': sign(body, tamper ? `${s.verification_token}x` : s.verification_token) }, body, signal: ctl2.signal });
                    clearTimeout(timer); status = r.status;
                } catch (_) { status = 0; }
                S.deliveries.push({ event: evt.uuid, type: evt.event_type, sub: s.uuid, attempt, status, tampered: tamper });
                if (status >= 200 && status < 300) return;
                if (tamper) return; // a tampered delivery is a probe, no retries
                await new Promise((r) => setTimeout(r, cfg.webhookRetryDelayMs));
            }
        }));
    }

    app.use((req, res) => err(res, 404, 'not_found', `No such endpoint: ${req.method} ${req.path}`));

    let server = null;
    return {
        app, state: () => S, cfg, reset, emit, deliver, approve,
        listen(port = 4010, host = '127.0.0.1') {
            return new Promise((resolve, reject) => {
                server = http.createServer(app);
                server.once('error', reject);
                server.listen(port, host, () => resolve({ url: `http://${host}:${server.address().port}`, port: server.address().port }));
            });
        },
        close() { return new Promise((r) => (server ? server.close(() => r()) : r())); }
    };
}

module.exports = { createMockGusto };
