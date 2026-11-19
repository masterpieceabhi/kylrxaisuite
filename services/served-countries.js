/**
 * Which countries this server is for.
 *
 * The same code runs for every country, and a company's own country decides its rules (country-config.js). What a
 * country ADDRESS decides is where the data lives: us.onnhr.com is a server with a database in the United States,
 * in.onnhr.com one in India. So each server is told which countries it takes, and a company of another country is
 * turned away at sign-up and pointed to the right address instead of being stored in the wrong place.
 *
 *   SERVED_COUNTRIES=US                      the countries this server takes: IN, US, CA, comma-separated
 *   COUNTRY_ADDRESSES=US=https://us.onnhr.com,IN=https://in.onnhr.com
 *                                            where each country is served, so a refusal can say where to go
 *
 * Without SERVED_COUNTRIES the server takes every country, as it did before (local development, one shared install).
 * With it:
 *   - a sign-up that names no country gets the server's own country when it serves exactly one
 *   - a sign-up that names a country we do not know is refused, instead of quietly becoming an Indian company
 *     (country-config.js falls back to India for anything it does not recognise)
 */
const { COUNTRIES, resolveCountryCode } = require('../country-config');
const { cleanOrigin } = require('../middleware/allowed-origins');

const KNOWN = Object.keys(COUNTRIES); // ['IN', 'US', 'CA']
const nameOf = (code) => (COUNTRIES[code] ? COUNTRIES[code].name : code);

/** The code of a country written any way we know ("usa", "United States", "IN"), or null when we do not know it */
function codeOf(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    const code = resolveCountryCode(v);
    if (code !== 'IN') return code;
    // resolveCountryCode answers IN for anything unknown, so India has to be recognised by name here
    return /^(in|ind|india)$/i.test(v) ? 'IN' : null;
}

/** { codes: the countries served ([] = all), addresses: { US: 'https://...' }, problems: [text] } */
function configured(env = process.env) {
    const problems = []; const codes = []; const addresses = {};
    for (const part of String(env.SERVED_COUNTRIES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const code = part.toUpperCase();
        if (!KNOWN.includes(code)) problems.push(`SERVED_COUNTRIES: "${part.slice(0, 20)}" is not one of ${KNOWN.join(', ')}`);
        else if (!codes.includes(code)) codes.push(code);
    }
    for (const part of String(env.COUNTRY_ADDRESSES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const at = part.indexOf('=');
        const code = at > 0 ? part.slice(0, at).trim().toUpperCase() : '';
        const origin = at > 0 ? cleanOrigin(part.slice(at + 1)) : null;
        if (!KNOWN.includes(code) || !origin) problems.push(`COUNTRY_ADDRESSES: "${part.slice(0, 60)}" must look like US=https://us.onnhr.com`);
        else addresses[code] = origin;
    }
    return { codes, addresses, problems };
}

const serves = (code, env = process.env) => { const c = configured(env).codes; return c.length === 0 || c.includes(code); };

/**
 * May a company of this country sign up here?
 *   { ok: true, code, country }     country: the name to store (the one sent, or this server's own when none was sent)
 *   { ok: false, status, code, error, country?, address? }
 */
function checkSignup(countrySent, env = process.env) {
    const cfg = configured(env);
    const sent = String(countrySent || '').trim();
    if (!cfg.codes.length) return { ok: true, code: resolveCountryCode(sent), country: sent }; // every country, as before
    const list = cfg.codes.map(nameOf).join(', ');
    if (!sent) {
        if (cfg.codes.length === 1) return { ok: true, code: cfg.codes[0], country: nameOf(cfg.codes[0]) };
        return { ok: false, status: 400, code: 'country_required', error: `Choose the company's country: ${list}.` };
    }
    const code = codeOf(sent);
    if (!code) return { ok: false, status: 400, code: 'country_unknown', error: `We do not serve that country yet. This address is for companies in: ${list}.` };
    if (cfg.codes.includes(code)) return { ok: true, code, country: sent };
    const address = cfg.addresses[code] || null;
    return {
        ok: false, status: 409, code: 'wrong_address', country: code, address,
        error: address ? `Companies in ${nameOf(code)} sign up at ${address}. This address is for companies in: ${list}.` : `This address is for companies in: ${list}. Companies in ${nameOf(code)} are not served here.`
    };
}

/** For the front door and the sign-up page: what this server takes, and where the other countries go */
function publicInfo(env = process.env) {
    const cfg = configured(env);
    const here = cfg.codes.length ? cfg.codes : KNOWN;
    return {
        restricted: cfg.codes.length > 0,
        serves: here.map((code) => ({ code, name: nameOf(code) })),
        elsewhere: Object.keys(cfg.addresses).filter((code) => !here.includes(code)).map((code) => ({ code, name: nameOf(code), address: cfg.addresses[code] }))
    };
}

module.exports = { KNOWN, codeOf, configured, serves, checkSignup, publicInfo };
