/**
 * The country of a company (organizations/{orgId}.country), looked up on the server and cached briefly.
 * Companies with no country stay India so existing India behavior is unchanged.
 */
const { rawCollection } = require('../config/firebase');
const { resolveCountryCode, getCountryConfig } = require('../country-config');

const TTL_MS = 60 * 1000;
const cache = new Map();

async function orgCountryCode(orgId) {
    if (!orgId) return 'IN';
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.code;
    let code = 'IN';
    try {
        const snap = await rawCollection('organizations').doc(orgId).get();
        if (snap.exists) code = resolveCountryCode(snap.data().country || snap.data().Country);
    } catch (_) { /* default */ }
    cache.set(orgId, { code, at: Date.now() });
    return code;
}

async function orgCountry(orgId) {
    return getCountryConfig(await orgCountryCode(orgId));
}

module.exports = { orgCountryCode, orgCountry, _clearCache: () => cache.clear() };
