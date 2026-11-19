// Which countries this server takes, and where the others go (GET /api/auth/region, services/served-countries.js).
// us.onnhr.com keeps its data in the United States and in.onnhr.com in India, so a person on the wrong address is
// shown the right one before they type anything in. A server that takes every country answers "not restricted" and
// nothing on the page changes. If the question cannot be asked at all, nothing changes either: the server still
// refuses a sign-up for the wrong country, with the same address in its answer.

let asked = null;

/** { restricted, serves: [{ code, name }], elsewhere: [{ code, name, address }] } or null. Asked once per page. */
export function loadRegion() {
    if (!asked) {
        asked = (async () => {
            try {
                const base = window.API_BASE || window.location.origin;
                const res = await fetch(`${base}/api/auth/region`, { signal: AbortSignal.timeout(6000) });
                const j = await res.json();
                return res.ok && j && j.success && Array.isArray(j.serves) ? j : null;
            } catch (_) { return null; }
        })();
    }
    return asked;
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
/** The entry for a country served somewhere else (by its name or code), or null */
export const elsewhereFor = (region, country) => ((region && region.elsewhere) || []).find((c) => same(c.name, country) || same(c.code, country)) || null;
export const servedHere = (region, country) => !region || !region.restricted || region.serves.some((c) => same(c.name, country) || same(c.code, country));

/** Only an https address is ever turned into a link */
const safe = (address) => { try { const u = new URL(String(address)); return u.protocol === 'https:' ? u : null; } catch (_) { return null; } };

/**
 * A line of text with a link: "Companies in India sign up at in.onnhr.com". `verb` is "sign up" or "sign in";
 * `path` is the page to open there (for example "signup.html"). Returns an element, or null when the address is not usable.
 */
export function addressLine(entry, verb, path = '') {
    const u = entry && safe(entry.address);
    if (!u) return null;
    const line = document.createElement('div');
    line.className = 'region-line';
    line.style.cssText = 'margin-top:10px;padding:10px 12px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;font-size:0.9rem;color:#1e3a8a;line-height:1.45';
    const a = document.createElement('a');
    a.href = `${u.origin}/${String(path).replace(/^\/+/, '')}`;
    a.textContent = u.host;
    a.style.cssText = 'font-weight:700;color:#1d4ed8';
    line.append(`Companies in ${entry.name} ${verb} at `, a, '.');
    return line;
}
