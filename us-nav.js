/**
 * One header bar and one footer for every signed-in US page.
 *
 * - The bar's quick links follow the person's role (from /api/us/me/permissions): an employee gets clock, hours,
 *   time off, pay and details; someone who approves gets the approval pages first; HR and the owner get People,
 *   Time, Time off, Payroll and Reports. Back, Home and Sign out are always there.
 * - Pages the person opens are remembered (on this device) so Home can show "Recently used".
 * - Nothing typed is lost: every form keeps a draft on this device while it is being filled in, offers it back
 *   after a reload or a lost connection, and warns before leaving a page with unsaved changes. Secret or
 *   identifying numbers (SSN, bank, PIN, passwords, date of birth) are never kept in a draft. Drafts are removed
 *   when the form is saved, after 7 days, and at sign-out.
 *
 * Loaded with <script type="module" src="us-nav.js?v=2"></script> at the end of each page. English or Spanish,
 * following the language picked on the employee pages (kylrx_lang).
 */
import { auth, onAuthStateChanged } from './firebase-config.js';

const T = {
    en: { home: 'Home', back: 'Back', clock: 'Clock in', hours: 'My hours', off: 'Time off', pay: 'My pay', me: 'My details', out: 'Sign out', help: 'Help', privacy: 'Privacy', skip: 'Skip to content',
        people: 'People', time: 'Approve hours', leave: 'Time off requests', payroll: 'Payroll', reports: 'Reports', team: 'My team',
        restored: 'We put back what you typed here before.', discard: 'Discard it', unsaved: 'You have changes that are not saved yet.' },
    es: { home: 'Inicio', back: 'Atrás', clock: 'Marcar entrada', hours: 'Mis horas', off: 'Tiempo libre', pay: 'Mi pago', me: 'Mis datos', out: 'Cerrar sesión', help: 'Ayuda', privacy: 'Privacidad', skip: 'Ir al contenido',
        people: 'Personas', time: 'Aprobar horas', leave: 'Solicitudes de tiempo libre', payroll: 'Nómina', reports: 'Informes', team: 'Mi equipo',
        restored: 'Recuperamos lo que escribió aquí antes.', discard: 'Descartarlo', unsaved: 'Tiene cambios sin guardar.' }
};
let lang = 'en';
try { lang = localStorage.getItem('kylrx_lang') === 'es' ? 'es' : 'en'; } catch (_) { /* English */ }
const t = T[lang];
const here = (location.pathname.split('/').pop() || '').toLowerCase();
const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* full or blocked: the page still works */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
    keys() { try { return Object.keys(localStorage); } catch (_) { return []; } }
};

const css = `
.onn-bar{position:sticky;top:0;z-index:900;display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:8px 16px;background:#0f172a;color:#e2e8f0;font:14px/1.3 system-ui,-apple-system,Segoe UI,sans-serif}
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
.onn-draft{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:950;background:#0f172a;color:#fff;padding:10px 14px;border-radius:10px;font:14px system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;max-width:92vw}
.onn-draft button{background:none;border:1px solid #475569;color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer;font:inherit}
@media (max-width:640px){.onn-bar{padding:6px 10px;gap:2px}.onn-bar .onn-wide{display:none}}
@media print{.onn-bar,.onn-foot,.onn-draft{display:none}}`;

// the everyday pages for everyone
const MINE = [['punch.html', t.clock], ['timesheet.html', t.hours], ['leave.html', t.off], ['my-pay.html', t.pay], ['my-profile.html', t.me]];

/** Quick links for this role, most used first; at most five so the bar stays one line on a laptop */
function quickFor(perms) {
    const has = (...p) => p.some((x) => perms.has(x));
    if (has('people.read', 'people.write')) {
        return [['admin-us-people.html', t.people], ['admin-us-time.html', t.time], ['admin-us-leave.html', t.leave],
            ...(has('payroll.view') ? [['admin-us-payroll.html', t.payroll]] : []), ...(has('reports.view') ? [['admin-us-reports.html', t.reports]] : [])].slice(0, 5);
    }
    if (has('time.approve_team', 'leave.decide_team', 'time.approve', 'leave.decide')) {
        return [['punch.html', t.clock], ...(has('time.approve', 'time.approve_team') ? [['admin-us-time.html', t.time]] : []),
            ...(has('leave.decide', 'leave.decide_team') ? [['admin-us-leave.html', t.leave]] : []), ['timesheet.html', t.hours], ['my-pay.html', t.pay]].slice(0, 5);
    }
    if (has('payroll.view')) return [['admin-us-payroll.html', t.payroll], ...(has('reports.view') ? [['admin-us-reports.html', t.reports]] : []), ['punch.html', t.clock], ['my-pay.html', t.pay]];
    if (has('reports.view')) return [['admin-us-reports.html', t.reports], ['punch.html', t.clock], ['my-pay.html', t.pay], ['my-profile.html', t.me]];
    return MINE;
}

const link = (href, text, cls = '') => `<a href="${href}"${cls ? ` class="${cls}"` : ''}${href === here ? ' aria-current="page"' : ''}>${text}</a>`;

function goBack() {
    // back within the app when we came from one of its pages, otherwise Home
    let sameSite = false;
    try { sameSite = Boolean(document.referrer) && new URL(document.referrer).origin === location.origin && !/\/(login|join)\.html/.test(document.referrer); } catch (_) { sameSite = false; }
    if (sameSite && history.length > 1) history.back(); else location.href = 'us-home.html';
}

async function signOut() {
    // drafts and the recent-pages list belong to this person: a shared computer must not keep them
    store.keys().filter((k) => k.startsWith('onn_draft:') || k.startsWith('onn_recent')).forEach((k) => store.del(k));
    try { sessionStorage.removeItem('onn_perms'); } catch (_) { /* ignore */ }
    try { await auth.signOut(); } catch (_) { /* go to the sign-in page either way */ }
    location.replace('login.html');
}

/* ------------------------------------------------------------------ bar and footer */

let quickHolder = null;
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
        + '<span data-onn-quick style="display:contents"></span>'
        + '<span class="onn-sp"></span>'
        + `<button type="button" class="onn-out" data-onn="out">${t.out}</button>`;
    document.body.prepend(bar);
    quickHolder = bar.querySelector('[data-onn-quick]');
    paintQuick(cachedPerms());

    if (!document.body.hasAttribute('data-no-onn-footer')) {
        const foot = document.createElement('footer');
        foot.className = 'onn-foot';
        foot.innerHTML = `<div>${link('us-home.html', t.home)}${MINE.map(([h, x]) => link(h, x)).join('')}<a href="my-privacy.html">${t.privacy}</a><a href="help.html">${t.help}</a><a href="#" data-onn="out">${t.out}</a></div>`
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

function cachedPerms() {
    try { const c = JSON.parse(sessionStorage.getItem('onn_perms') || 'null'); if (c && Date.now() - c.at < 10 * 60000) return c; } catch (_) { /* none */ }
    return null;
}
function paintQuick(me) {
    if (!quickHolder) return;
    const list = me ? quickFor(new Set(me.permissions || [])) : MINE;
    quickHolder.innerHTML = list.map(([h, x]) => link(h, x, 'onn-wide')).join('');
}
async function loadPerms(user) {
    if (cachedPerms()) return;
    try {
        const res = await fetch('/api/us/me/permissions', { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
        if (!res.ok) return;
        const me = await res.json();
        const c = { at: Date.now(), userId: me.userId, role: me.role, permissions: me.permissions || [] };
        try { sessionStorage.setItem('onn_perms', JSON.stringify(c)); } catch (_) { /* ignore */ }
        paintQuick(c);
    } catch (_) { /* the everyday links stay */ }
}

/* ------------------------------------------------------------------ recently used (Home shows it) */

function remember(uid) {
    if (!uid || here === 'us-home.html' || !/\.html$/.test(here)) return;
    const key = `onn_recent:${uid}`;
    let list = [];
    try { list = JSON.parse(store.get(key) || '[]'); } catch (_) { list = []; }
    const title = (document.querySelector('h1') || {}).textContent || document.title.split('|')[0];
    list = [{ href: here, title: String(title).trim().slice(0, 60) }, ...list.filter((x) => x && x.href !== here)].slice(0, 6);
    store.set(key, JSON.stringify(list));
}

/* ------------------------------------------------------------------ drafts: nothing typed is lost */

const SECRET = /ssn|social|taxpayer|\btin\b|itin|account|routing|aba|iban|\bpin\b|pin$|password|passcode|secret|token|card|cvv|cvc|birth|dob|signature/i;
const DRAFT_DAYS = 7;
let uidForDrafts = null;
const dirty = new Set();

function fieldKey(el) { return el.name || el.id || ''; }
function isKeepable(el) {
    if (!el || !el.form || el.disabled || el.readOnly) return false;
    const type = String(el.type || '').toLowerCase();
    if (['password', 'hidden', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
    const k = fieldKey(el);
    if (!k) return false;
    const label = (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.placeholder || '';
    return !SECRET.test(`${k} ${label} ${el.autocomplete || ''}`);
}
function formKey(form) {
    const forms = [...document.querySelectorAll('form')];
    return `onn_draft:${uidForDrafts}:${here}:${form.id || form.getAttribute('name') || `form${forms.indexOf(form)}`}`;
}
function readForm(form) {
    const v = {};
    [...form.elements].forEach((el) => {
        if (!isKeepable(el)) return;
        const k = fieldKey(el);
        if (el.type === 'checkbox') v[k] = el.checked;
        else if (el.type === 'radio') { if (el.checked) v[k] = el.value; }
        else v[k] = el.value;
    });
    return v;
}
function saveDraft(form) {
    if (!uidForDrafts) return;
    const values = readForm(form);
    if (!Object.values(values).some((x) => x !== '' && x !== false)) { store.del(formKey(form)); return; }
    store.set(formKey(form), JSON.stringify({ at: Date.now(), values }));
}

let saveTimer = null;
document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isKeepable(el)) return;
    dirty.add(el.form);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(el.form), 400);
}, true);
document.addEventListener('change', (e) => { const el = e.target; if (isKeepable(el)) { dirty.add(el.form); saveDraft(el.form); } }, true);

// a sent form: once the page shows no error a moment later, the draft has done its job
document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    dirty.delete(form); // sent: leaving now does not need a warning
    setTimeout(() => {
        const err = [...document.querySelectorAll('#msg.err, #msg.error, .err[role=alert], [role=alert].err, .alert-danger')].some((x) => x.offsetParent !== null && x.textContent.trim());
        if (!err) store.del(formKey(form)); else dirty.add(form); // refused: keep the draft and the warning
    }, 2500);
}, true);

// leaving with typed changes that were not sent: the browser asks first (the draft is kept either way)
window.addEventListener('beforeunload', (e) => {
    const unsent = [...dirty].some((f) => f && document.contains(f) && store.get(formKey(f)));
    if (unsent) { e.preventDefault(); e.returnValue = t.unsaved; return t.unsaved; }
    return undefined;
});

function offerDrafts() {
    if (!uidForDrafts) return;
    // old drafts go
    store.keys().filter((k) => k.startsWith('onn_draft:')).forEach((k) => {
        try { const d = JSON.parse(store.get(k)); if (!d || Date.now() - d.at > DRAFT_DAYS * 86400000) store.del(k); } catch (_) { store.del(k); }
    });
    // a form on screen gets its draft now; one that is still closed (an editor, a dialog) when it is first used
    document.querySelectorAll('form').forEach((form) => { if (form.offsetParent !== null) restoreInto([form]); });
}
const tried = new WeakSet();
document.addEventListener('focusin', (e) => {
    const form = e.target && e.target.form;
    if (form && uidForDrafts && !tried.has(form)) restoreInto([form]);
}, true);

function restoreInto(forms) {
    const restored = [];
    forms.forEach((form) => {
        if (tried.has(form)) return;
        tried.add(form);
        let d = null;
        try { d = JSON.parse(store.get(formKey(form)) || 'null'); } catch (_) { d = null; }
        if (!d || !d.values) return;
        let filled = 0;
        [...form.elements].forEach((el) => {
            if (!isKeepable(el)) return;
            const k = fieldKey(el);
            if (!(k in d.values)) return;
            const v = d.values[k];
            // only empty fields are filled: what the page loaded from the server always wins
            if (el.type === 'checkbox') { if (!el.checked && v === true) { el.checked = true; filled += 1; } }
            else if (el.type === 'radio') { if (el.value === v && !form.querySelector(`[name="${CSS.escape(k)}"]:checked`)) { el.checked = true; filled += 1; } }
            else if (!el.value && v) { el.value = v; filled += 1; }
        });
        if (filled) { restored.push(form); dirty.add(form); }
    });
    if (!restored.length) return;
    const note = document.createElement('div');
    note.className = 'onn-draft'; note.setAttribute('role', 'status');
    note.innerHTML = `<span>${t.restored}</span><button type="button">${t.discard}</button>`;
    note.querySelector('button').addEventListener('click', () => {
        restored.forEach((f) => { store.del(formKey(f)); dirty.delete(f); f.reset(); });
        note.remove();
    });
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 15000);
}

/* ------------------------------------------------------------------ start */

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
onAuthStateChanged(auth, (user) => {
    if (!user) return;
    uidForDrafts = user.uid;
    remember(user.uid);
    loadPerms(user);
    // the page fills its forms from the server first; drafts only fill what is still empty after that
    setTimeout(offerDrafts, 1800);
});
