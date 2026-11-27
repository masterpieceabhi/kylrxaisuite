/**
 * The name of the company the signed-in person belongs to, for anything that goes out in the company's name:
 * pay slips, offer letters, documents. Onn HR is the product, never the employer, so it is never used here.
 * Returns '' when the name cannot be found; callers then leave the name out rather than invent one.
 */
import { db, doc, getDoc } from "./firebase-config.js";

const KEY = 'onnhr_company_name';

export const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function companyName() {
    const orgId = localStorage.getItem('orgId') || '';
    try {
        const held = JSON.parse(sessionStorage.getItem(KEY) || 'null');
        if (held && held.orgId === orgId && held.name) return held.name;
    } catch (_) { /* a broken cache entry is just ignored */ }
    let name = '';
    if (orgId) {
        try {
            const snap = await getDoc(doc(db, 'organizations', orgId));
            const o = snap.exists() ? snap.data() : {};
            name = String(o.displayName || o.name || o.legalName || o.companyName || (o.profile && o.profile.name) || '').trim();
        } catch (_) { name = ''; }
    }
    if (!name) name = String(localStorage.getItem('companyName') || '').trim(); // set at sign-up on this device
    name = name.slice(0, 120);
    if (name) { try { sessionStorage.setItem(KEY, JSON.stringify({ orgId, name })); } catch (_) { /* private window */ } }
    return name;
}
