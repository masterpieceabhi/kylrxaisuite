/**
 * Applies the signed-in company's country to the page: hides India-only navigation for US/Canada
 * companies and sends direct visits to India-only pages back to the dashboard.
 * Loaded by the admin and HRMS sidebar scripts. Companies without a country stay on India.
 */
import { auth, db, onAuthStateChanged, doc, getDoc } from './firebase-config.js';
import './country-config.js';

const Country = window.KylrxCountry;
const CACHE_KEY = 'kylrx_org_country';

function currentPage() {
    return window.location.pathname.split('/').pop() || '';
}

function dashboardFor(page) {
    return page.startsWith('hrms-') ? 'hrms-dashboard.html' : 'admin-dashboard.html';
}

export function applyCountry(value) {
    if (!Country) return;
    const cfg = Country.getCountryConfig(value);
    window.KylrxCountryConfig = cfg;
    document.documentElement.setAttribute('data-country', cfg.code);

    const page = currentPage();
    if (Country.isPageHidden(cfg.code, page)) {
        window.location.replace(dashboardFor(page));
        return;
    }

    document.querySelectorAll('a[href]').forEach((link) => {
        if (!Country.isPageHidden(cfg.code, link.getAttribute('href'))) return;
        const holder = link.closest('.nav-item') || link;
        holder.style.display = 'none';
    });
    document.querySelectorAll('[data-country-only]').forEach((el) => {
        const allowed = el.getAttribute('data-country-only').split(',').map((c) => c.trim().toUpperCase());
        const holder = el.closest('.nav-item') || el;
        holder.style.display = allowed.includes(cfg.code) ? '' : 'none';
    });

    // The payroll page keeps India tabs on one page; send a US/CA visit to a hidden tab to Documents
    if (typeof window.switchPayrollTab === 'function' && /^#(compliance|disbursement)$/.test(window.location.hash)) {
        const tabLink = document.getElementById(window.location.hash === '#compliance' ? 'tabBtnCompliance' : 'tabBtnDisbursement');
        if (tabLink && tabLink.getAttribute('data-country-only') && tabLink.style.display === 'none') {
            window.switchPayrollTab('docs');
        }
    }
}

async function loadCountry(user) {
    let orgId = null;
    try {
        const token = await user.getIdTokenResult();
        orgId = token.claims.orgId || null;
    } catch (_) {}
    orgId = orgId || localStorage.getItem('orgId');
    if (!orgId) return;
    try {
        const snap = await getDoc(doc(db, 'organizations', orgId));
        const data = snap.exists() ? snap.data() : {};
        const country = data.country || data.Country || 'IN';
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ orgId, country }));
        applyCountry(country);
    } catch (_) {}
}

try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (cached && cached.country) applyCountry(cached.country);
} catch (_) {}

onAuthStateChanged(auth, (user) => {
    if (user) loadCountry(user);
    else sessionStorage.removeItem(CACHE_KEY);
});
