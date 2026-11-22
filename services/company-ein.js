/**
 * The company's EIN (and legal name and address): taken from Gusto first, asked for only when something needs it.
 *
 *   1. When the company connects its Gusto account (and whenever fillFromGusto() is called later), the company record
 *      at Gusto (GET /v1/companies/{uuid}: ein, name, entity_type, locations) fills the EMPTY fields of the company
 *      profile. A value the company typed is never overwritten; a Gusto EIN that differs from the typed one is only
 *      reported (einMismatch), so the owner can check which is right.
 *   2. A feature that cannot work without an EIN (today: the state new-hire report file) calls ensureEin(). It returns
 *      the stored EIN, or tries Gusto once, or answers { needed: true } so the page can ask for it in place and retry.
 *
 * Fields filled from Gusto are listed in usProfile.fromGusto { at, fields } so the company page can say
 * "from Gusto, please check". The EIN is not a secret (it is printed on every W-2), but it is never logged.
 * Gusto's company fields were taken from its API reference; the field names are read defensively.
 */
const V = require('./us-validation');

const ENTITY = [
    [/c[\s-]?corp/i, 'c_corp'], [/s[\s-]?corp/i, 's_corp'], [/\bllc\b/i, 'llc'], [/sole/i, 'sole_proprietorship'],
    [/non[\s-]?profit|association/i, 'nonprofit'], [/partnership|\bllp\b|joint venture|co-ownership/i, 'partnership']
];
const nowIso = () => new Date().toISOString();

/** Pure. Gusto's company record -> the fields of our company profile that it can fill. */
function factsFromGustoCompany(c) {
    const out = {};
    if (!c || typeof c !== 'object') return out;
    const ein = V.validateEin(c.ein);
    if (c.ein && ein.valid) out.ein = ein.formatted;
    const name = String(c.name || '').trim();
    if (name) out.legalName = name.slice(0, 200);
    const entity = ENTITY.find(([re]) => re.test(String(c.entity_type || '')));
    if (entity) out.entityType = entity[1];
    const locs = (Array.isArray(c.locations) ? c.locations : []).filter((l) => l && l.active !== false && l.street_1 && l.city && l.state && l.zip);
    const main = locs.find((l) => l.filing_address) || locs.find((l) => l.mailing_address) || locs[0];
    if (main) {
        const a = V.validateAddress({ line1: main.street_1, line2: main.street_2 || '', city: main.city, state: String(main.state).toUpperCase(), zip: String(main.zip).slice(0, 10) });
        if (!a.errors.length) out.businessAddress = a.value;
    }
    const states = [...new Set(locs.map((l) => String(l.state).toUpperCase()).filter((s) => V.US_STATES.includes(s)))];
    if (states.length) out.workStates = states;
    return out;
}

const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some(Boolean));

/** Pure. Which facts may be written: only into empty fields. */
function mergeFacts(profile, facts) {
    const p = profile || {};
    const patch = {};
    for (const [k, v] of Object.entries(facts || {})) if (empty(p[k]) && !empty(v)) patch[k] = v;
    const einMismatch = Boolean(p.ein && facts && facts.ein && String(p.ein).replace(/\D/g, '') !== String(facts.ein).replace(/\D/g, ''));
    return { patch, filled: Object.keys(patch), einMismatch };
}

/* --------------------------------- the real thing --------------------------------- */

async function loadOrg(orgId) {
    const snap = await require('../config/firebase').rawCollection('organizations').doc(String(orgId)).get();
    return (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : {};
}

/**
 * Reads the company at Gusto and fills the empty profile fields. Never throws.
 *   company: Gusto's record when the caller already has it (the connect step); otherwise it is fetched.
 * -> { ok, filled: [...], einMismatch, reason }
 */
async function fillFromGusto(orgId, { company, deps = {} } = {}) {
    const logger = require('../utils/logger');
    try {
        let c = company;
        if (!c) {
            const ctx = await (deps.makeContext || require('./gusto').makeContext)(orgId, deps);
            if (!ctx.conn || ctx.conn.status !== 'connected' || !ctx.conn.companyUuid) return { ok: false, filled: [], reason: 'not_connected' };
            c = await ctx.client.get(`/v1/companies/${encodeURIComponent(ctx.conn.companyUuid)}`);
        }
        const facts = factsFromGustoCompany(c);
        if (!Object.keys(facts).length) return { ok: false, filled: [], reason: 'nothing_at_gusto' };
        const org = deps.org || await loadOrg(orgId);
        const profile = org.usProfile || {};
        const { patch, filled, einMismatch } = mergeFacts(profile, facts);
        if (filled.length || einMismatch) {
            const at = nowIso();
            const save = deps.saveProfile || (async (p) => require('../config/firebase').rawCollection('organizations').doc(String(orgId)).set({ usProfile: p }, { merge: true }));
            await save({ ...patch, fromGusto: { at, fields: [...new Set([...((profile.fromGusto && profile.fromGusto.fields) || []), ...filled])], ...(einMismatch ? { einMismatch: true } : {}) }, ...(filled.length ? { updatedAt: at } : {}) });
            if (!deps.saveProfile) {
                try { await require('./audit-chain').writeAudit(orgId, { action: 'us_company_profile_filled_from_gusto', targetId: orgId, actorId: 'gusto', actorRole: 'system', at, fields: filled, einMismatch }); } catch (_) { /* never fails the fill */ }
            }
        }
        return { ok: true, filled, einMismatch, reason: filled.length ? null : 'already_filled' };
    } catch (e) {
        logger.warn(`[CompanyEIN] could not read the company at Gusto for ${orgId}: ${String(e && e.message).slice(0, 160)}`);
        return { ok: false, filled: [], reason: 'gusto_error' };
    }
}

/**
 * For a feature that needs the EIN. -> { ein } or { needed: true, triedGusto }
 * The stored EIN wins; without one, Gusto is tried once; without that, the caller asks the person.
 */
async function ensureEin(orgId, org, { deps = {} } = {}) {
    const has = org && org.usProfile && org.usProfile.ein;
    if (has) return { ein: org.usProfile.ein, source: 'profile' };
    const r = await fillFromGusto(orgId, { deps: { ...deps, org } });
    if (r.filled.includes('ein')) {
        const fresh = deps.org ? { ...deps.org.usProfile } : (await loadOrg(orgId)).usProfile || {};
        if (fresh.ein) return { ein: fresh.ein, source: 'gusto' };
    }
    return { needed: true, triedGusto: r.reason !== 'not_connected' };
}

/** The answer a route gives when the EIN is missing, in one shape for every page (see us-ein.js). */
const einNeeded = (res, what) => res.status(409).json({ success: false, code: 'ein_needed', error: `Your company's EIN (federal employer ID) is needed for ${what}. Enter it once and it is kept in Company details.` });

module.exports = { factsFromGustoCompany, mergeFacts, fillFromGusto, ensureEin, einNeeded };
