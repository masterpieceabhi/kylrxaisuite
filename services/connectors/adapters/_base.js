/**
 * Adapter definition helper. Every connector implements the same interface:
 *
 *   authenticate(ctx)                         get/refresh credentials, returns auth info (kept on ctx.auth)
 *   healthCheck(ctx)                          cheap authenticated call -> { ok, detail }
 *   map(entityKey, record, ctx)               canonical record -> { payload, errors } using declarative rules
 *                                             (connector defaults merged with the company's overrides) + a vendor `shape`
 *   validate(entityKey, payload, record, ctx) -> list of problems (non-retryable)
 *   push(entityKey, payload, ctx, { remoteId })   -> { remoteId }      (upsert; must be safe to repeat)
 *   pull(entityKey, ctx, { cursor })          -> { records, cursor }   (optional)
 *   handleEvent(event, ctx)                   event-driven connectors (Slack, Teams)
 *
 * ctx = { conn: { id, orgId, config, credentials, mapping }, http, now(), auth, saveCredentials(patch) }
 */
const { applyMapping, mergeMappings } = require('../mapping');
const { HttpError } = require('../http');

const tokenCache = new Map();
const b64 = (s) => Buffer.from(String(s)).toString('base64');

/** OAuth 2 token request with a small cache (per connection + token URL) */
async function oauthToken(ctx, { url, form, basic, headers = {}, cacheKey }) {
    const key = `${ctx.conn.id}|${cacheKey || url}`;
    const hit = tokenCache.get(key);
    if (hit && hit.expires > Date.now() + 30000) return hit.value;
    const res = await ctx.http.request({ method: 'POST', url, form, headers: { ...(basic ? { Authorization: `Basic ${b64(`${basic.id}:${basic.secret}`)}` } : {}), ...headers } });
    if (!res.json || !res.json.access_token) throw new HttpError('token endpoint did not return an access_token', { status: res.status });
    const value = { token: res.json.access_token, type: res.json.token_type || 'Bearer', raw: res.json };
    tokenCache.set(key, { value, expires: Date.now() + (Number(res.json.expires_in) || 3000) * 1000 });
    return value;
}
const clearTokens = () => tokenCache.clear();

const xmlEscape = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function defineAdapter(def) {
    const rulesFor = (entityKey, ctx) => mergeMappings(def.defaultMappings[entityKey] || [], ((ctx.conn && ctx.conn.mapping) || {})[entityKey]);
    const adapter = {
        key: def.key, name: def.name, category: def.category, description: def.description, vendor: def.vendor,
        entities: def.entities || [], credentialFields: def.credentialFields || [], configFields: def.configFields || [],
        needsVerification: def.needsVerification || [], defaultMappings: def.defaultMappings || {}, eventDriven: Boolean(def.handleEvent), batch: Boolean(def.pushBatch),
        mappingFields: def.mappingFields || {},
        rulesFor,
        async authenticate(ctx) { ctx.auth = def.authenticate ? await def.authenticate(ctx) : {}; return ctx.auth; },
        async healthCheck(ctx) {
            const t = Date.now();
            try {
                await adapter.authenticate(ctx);
                const detail = def.healthCheck ? await def.healthCheck(ctx) : 'authenticated';
                return { ok: true, detail: typeof detail === 'string' ? detail : 'ok', latencyMs: Date.now() - t };
            } catch (e) { return { ok: false, detail: String(e.message).slice(0, 300), latencyMs: Date.now() - t }; }
        },
        map(entityKey, record, ctx) {
            const r = applyMapping(rulesFor(entityKey, ctx), record);
            const payload = def.shape && def.shape[entityKey] ? def.shape[entityKey](r.value, record, ctx) : r.value;
            return { payload, errors: r.errors };
        },
        validate(entityKey, payload, record, ctx) { return def.validate ? def.validate(entityKey, payload, record, ctx) : []; },
        async push(entityKey, payload, ctx, opts) { return def.push(entityKey, payload, ctx, opts || {}); },
        async pushBatch(entityKey, items, ctx) { return def.pushBatch(entityKey, items, ctx); },
        async pull(entityKey, ctx, opts) { return def.pull ? def.pull(entityKey, ctx, opts || {}) : { records: [], cursor: null }; },
        mapInbound: def.mapInbound,
        async handleEvent(event, ctx) { return def.handleEvent(event, ctx); }
    };
    return adapter;
}

const journalEntity = { key: 'journal', direction: 'push', source: 'payroll_journal', label: 'Payroll journal entries' };
const peopleEntity = (key, label) => ({ key, direction: 'push', source: 'people', label });

const ACCOUNT_FIELDS = [
    { key: 'accounts.wages_expense', label: 'Wages expense account' }, { key: 'accounts.employer_tax_expense', label: 'Employer tax expense account' },
    { key: 'accounts.tax_payable', label: 'Payroll taxes payable account' }, { key: 'accounts.deductions_payable', label: 'Deductions payable account' },
    { key: 'accounts.net_pay_clearing', label: 'Net pay / cash clearing account' }
];

/** config.accounts.* are edited as flat keys in the UI */
const accountsOf = (ctx) => ((ctx.conn.config || {}).accounts) || {};

module.exports = { defineAdapter, oauthToken, clearTokens, xmlEscape, b64, journalEntity, peopleEntity, ACCOUNT_FIELDS, accountsOf, HttpError };
