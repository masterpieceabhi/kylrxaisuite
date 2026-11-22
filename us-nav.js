/**
 * One header bar and one footer for every signed-in US page, so a person can always get Home, go back, reach the
 * everyday pages (clock, hours, time off, pay, details) and sign out from the same place.
 * Loaded with <script type="module" src="us-nav.js?v=1"></script> at the end of each page; it adds itself and
 * leaves the page's own header (with that page's own links) as it is.
 * English or Spanish, following the language the person picked on the employee pages (kylrx_lang).
 */
import { auth } from './firebase-config.js';

const T = {
    en: { home: 'Home', back: 'Back', clock: 'Clock in', hours: 'My hours', off: 'Time off', pay: 'My pay', me: 'My details', out: 'Sign out', help: 'Help', privacy: 'Privacy', skip: 'Skip to content' },
    es: { home: 'Inicio', back: 'Atrás', clock: 'Marcar entrada', hours: 'Mis horas', off: 'Tiempo libre', pay: 'Mi pago', me: 'Mis datos', out: 'Cerrar sesión', help: 'Ayuda', privacy: 'Privacidad', skip: 'Ir al contenido' }
};
let lang = 'en';
try { lang = localStorage.getItem('kylrx_lang') === 'es' ? 'es' : 'en'; } catch (_) { /* English */ }
const t = T[lang];
const here = (location.pathname.split('/').pop() || '').toLowerCase();

const css = `
.onn-bar{position:sticky;top:0;z-index:900;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;background:#0f172a;color:#e2e8f0;font:14px/1.3 system-ui,-apple-system,Segoe UI,sans-serif}
.onn-bar a,.onn-bar button{color:#e2e8f0;text-decoration:none;background:none;border:0;font:inherit;cursor:pointer;padding:6px 10px;border-radius:8px;white-space:nowrap}
.onn-bar a:hover,.onn-bar button:hover,.onn-bar a:focus-visible,.onn-bar button:focus-visible{background:#1e293b;outline:none}
.onn-bar a[aria-current=page]{background:#1e3a8a;color:#fff}
.onn-bar .onn-brand{font-weight:800;color:#fff;padding-left:0}
.onn-bar .onn-sp{flex:1}
.onn-bar .onn-out{border:1px solid #334155}
.onn-foot{margin:40px 0 0;padding:18px 16px 24px;border-top:1px solid #e2e8f0;background:#f8fafc;color:#64748b;font:13px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center}
.onn-foot a{color:#2563eb;text-decoration:none;margin:0 8px;white-space:nowrap}
.onn-foot a:hover{text-decoration:underline}
.onn-skip{position:absolute;left:-9999px}.onn-skip:focus{left:8px;top:8px;z-index:1000;background:#fff;color:#0f172a;padding:6px 10px;border-radius:6px}
@media (max-width:640px){.onn-bar{padding:6px 10px;gap:2px}.onn-bar .onn-wide{display:none}}
@media print{.onn-bar,.onn-foot{display:none}}`;

const QUICK = [
    ['punch.html', t.clock], ['timesheet.html', t.hours], ['leave.html', t.off], ['my-pay.html', t.pay], ['my-profile.html', t.me]
];
const link = (href, text, cls = '') => `<a href="${href}"${cls ? ` class="${cls}"` : ''}${href === here ? ' aria-current="page"' : ''}>${text}</a>`;

function goBack() {
    // back within the app when we came from one of its pages, otherwise Home
    let sameSite = false;
    try { sameSite = Boolean(document.referrer) && new URL(document.referrer).origin === location.origin && !/\/(login|join)\.html/.test(document.referrer); } catch (_) { sameSite = false; }
    if (sameSite && history.length > 1) history.back(); else location.href = 'us-home.html';
}

async function signOut() {
    try { await auth.signOut(); } catch (_) { /* go to the sign-in page either way */ }
    location.replace('login.html');
}

function build() {
    if (document.querySelector('.onn-bar')) return;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    const main = document.querySelector('main') || document.body.firstElementChild;
    if (main && !main.id) main.id = 'onn-main';

    const bar = document.createElement('nav');
    bar.className = 'onn-bar'; bar.setAttribute('aria-label', 'Onn HR');
    bar.innerHTML = `<a class="onn-skip" href="#${main ? main.id : ''}">${t.skip}</a>`
        + `<a class="onn-brand" href="us-home.html" title="${t.home}">Onn HR</a>`
        + `<button type="button" data-onn="back" aria-label="${t.back}">&larr; ${t.back}</button>`
        + link('us-home.html', t.home)
        + QUICK.map(([h, x]) => link(h, x, 'onn-wide')).join('')
        + '<span class="onn-sp"></span>'
        + `<button type="button" class="onn-out" data-onn="out">${t.out}</button>`;
    document.body.prepend(bar);

    // pages with their own big footer (the clock) keep theirs
    if (!document.body.hasAttribute('data-no-onn-footer')) {
        const foot = document.createElement('footer');
        foot.className = 'onn-foot';
        foot.innerHTML = `<div>${link('us-home.html', t.home)}${QUICK.map(([h, x]) => link(h, x)).join('')}<a href="my-privacy.html">${t.privacy}</a><a href="mailto:support@promptaiusa.com">${t.help}</a><a href="#" data-onn="out">${t.out}</a></div>`
            + `<div>&copy; ${new Date().getFullYear()} Prompt AI Ethical Solutions USA LLC &middot; Onn HR</div>`;
        document.body.appendChild(foot);
    }

    document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-onn]');
        if (!b) return;
        e.preventDefault();
        if (b.dataset.onn === 'back') goBack();
        else if (b.dataset.onn === 'out') signOut();
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
