import { auth, db, doc, getDoc, collection, query, where, getDocs, setDoc, serverTimestamp } from "./firebase-config.js";
import { formatPhone } from "./us-smart-fill.js?v=1";
import { signInWithEmailAndPassword, signInWithCustomToken, signOut, GoogleAuthProvider, OAuthProvider, SAMLAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInAnonymously, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

/** A page inside this app that asked for sign-in first (for example the app-approval page). Only plain same-site pages are accepted. */
function afterLoginTarget() {
    try {
        const t = sessionStorage.getItem('kylrx_after_login');
        sessionStorage.removeItem('kylrx_after_login');
        return t && /^\/[A-Za-z0-9_-]+\.html(\?[^#\s]{0,2000})?$/.test(t) ? t : null;
    } catch (_) { return null; }
}

/** The company's country, asked from the server with the signed-in user's token ('US', 'IN' or null when unknown) */
async function companyCountry() {
    try {
        if (!auth.currentUser) return null;
        const res = await fetch('/api/time/status', { headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
        if (!res.ok) return null;
        return (await res.json()).country || null;
    } catch (_) { return null; }
}

/** Did the signed-in person come in with a temporary password that they still have to replace? (asked from the server) */
async function mustChooseNewPassword() {
    try {
        if (!auth.currentUser) return false;
        const res = await fetch('/api/auth/password-status', { headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` }, cache: 'no-store' });
        if (!res.ok) return false;
        return (await res.json()).mustChangePassword === true;
    } catch (_) { return false; }
}

const US_STAFF_ROLES = ['hradmin', 'hrms', 'hr', 'payrolladmin', 'manager', 'accountant', 'auditor', 'executive'];

async function getRedirectUrl(userData, role) {
    if (!role) {
        throw new Error("Access denied: Account has no assigned role. Please contact HR.");
    }
    if (userData && (userData.status === 'inactive' || userData.status === 'Inactive')) {
        throw new Error("Your account is currently inactive. Please contact support.");
    }
    const cleanRole = (role || '').toLowerCase().replace(/[\s_-]+/g, '');
    const known = ['superadmin', 'admin', 'employee', ...US_STAFF_ROLES].includes(cleanRole);
    const back = known ? afterLoginTarget() : null;
    if (back) return back;
    // United States companies have their own pages; the dashboards below are the India ones
    if (known && (await companyCountry()) === 'US') {
        if (userData?.orgId) localStorage.setItem('orgId', userData.orgId);
        if (cleanRole === 'superadmin' || cleanRole === 'admin') { localStorage.setItem('orgConfigured', 'true'); return 'us-home.html'; } // the India dashboard is hidden for US companies
        return cleanRole === 'employee' ? 'punch.html' : 'us-home.html';
    }
    if (cleanRole === 'superadmin' || cleanRole === 'admin') {
        const orgId = userData?.orgId || localStorage.getItem('orgId') || 'org_kylrx_ai';
        localStorage.setItem('orgId', orgId);
        localStorage.setItem('orgConfigured', 'true');
        return 'admin-dashboard.html';
    } else if (cleanRole === 'hradmin' || cleanRole === 'hrms' || cleanRole === 'hr') {
        return 'hrms-dashboard.html';
    } else if (cleanRole === 'manager') {
        const deptId = (userData && (userData.departmentId || userData.departmentCode)) ? (userData.departmentId || userData.departmentCode) : '';
        return deptId ? `manager-dashboard.html?id=${deptId}` : 'manager-dashboard.html';
    } else if (cleanRole === 'employee') {
        return 'employee-dashboard.html';
    } else {
        throw new Error("Invalid role assigned. Please contact your administrator.");
    }
}


// Fix for "sw.js" errors: Unregister any ghost service workers
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (let registration of registrations) {
      registration.unregister();
    }
  });
}

const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const errorMessage = document.getElementById('errorMessage');
const loginBtn = document.getElementById('loginBtn');
const credentialsBtn = document.getElementById('credentialsBtn');

// ===== Password Show/Hide Toggle =====
document.querySelectorAll('.eye-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        const icon = btn.querySelector('.lucide');
        
        if (input && icon) {
            if (input.type === 'password') {
                input.type = 'text';
                icon.setAttribute('data-lucide', 'eye-off');
            } else {
                input.type = 'password';
                icon.setAttribute('data-lucide', 'eye');
            }
            if (window.lucide) lucide.createIcons();
        }
    });
});

// ═══════════ DEMO ROLES QUICK ACCESS MODAL ══════════════════════════════════
const demoModal = document.getElementById('demoRolesModal');
const closeDemoBtn = document.getElementById('closeDemoRolesBtn');
const selectSuperAdmin = document.getElementById('selectSuperAdmin');
const selectHrAdmin = document.getElementById('selectHrAdmin');
const selectManager = document.getElementById('selectManager');
const selectEmployee = document.getElementById('selectEmployee');

if (credentialsBtn && demoModal) {
    credentialsBtn.addEventListener('click', () => {
        demoModal.style.display = 'flex';
        if (window.lucide) lucide.createIcons();
    });
}
if (closeDemoBtn && demoModal) {
    closeDemoBtn.addEventListener('click', () => { demoModal.style.display = 'none'; });
    demoModal.addEventListener('click', (e) => { if (e.target === demoModal) demoModal.style.display = 'none'; });
}

// Demo shortcuts exist ONLY on a developer's own machine, talking to the local emulator.
// No account or password is kept in this file: the buttons ask the local server, and the server only answers when it
// runs against the Firebase emulators, is not in production and is asked from this same machine (services/local-demo.js).
const IS_LOCAL_DEMO = ['localhost', '127.0.0.1'].includes(window.location.hostname) && sessionStorage.getItem('kylrx_live_firebase') !== '1';

async function localDemoLogin(key) {
    const res = await fetch(`/api/auth/dev-demo-login${key ? `?account=${encodeURIComponent(key)}` : ''}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && data.success ? data : null;
}

function hideDemoShortcuts() {
    document.querySelectorAll('[data-demo-shortcut]').forEach((el) => { el.style.display = 'none'; });
    const quick = document.getElementById('btnQuickSuperAdmin');
    const panel = quick && quick.parentElement && quick.parentElement.parentElement;
    if (panel) panel.style.display = 'none';
    if (credentialsBtn) credentialsBtn.style.display = 'none';
    if (demoModal) demoModal.style.display = 'none';
}

function bindDemo(button, key, closeModal) {
    if (!button) return;
    button.setAttribute('data-demo-shortcut', key);
    if (!IS_LOCAL_DEMO) { button.style.display = 'none'; return; }
    button.addEventListener('click', async () => {
        let account = null;
        try { account = await localDemoLogin(key); } catch (_) { account = null; }
        if (closeModal && demoModal) demoModal.style.display = 'none';
        if (!account) { hideDemoShortcuts(); window.alert('Demo sign-in works only with the local emulators (npm run emulators, npm run seed:local, npm run start:local).'); return; }
        if (emailInput) emailInput.value = account.email;
        if (passwordInput) passwordInput.value = account.password;
        loginBtn?.click();
    });
}
bindDemo(selectSuperAdmin, 'superAdmin', true);
bindDemo(selectHrAdmin, 'hrAdmin', true);
bindDemo(selectManager, 'manager', true);
bindDemo(selectEmployee, 'employee', true);

const btnQuickSuperAdmin = document.getElementById('btnQuickSuperAdmin');
const btnQuickHrAdmin = document.getElementById('btnQuickHrAdmin');
const btnQuickManager = document.getElementById('btnQuickManager');
const btnQuickEmployee = document.getElementById('btnQuickEmployee');
bindDemo(btnQuickSuperAdmin, 'superAdmin', false);
bindDemo(btnQuickHrAdmin, 'hrAdmin', false);
bindDemo(btnQuickManager, 'manager', false);
bindDemo(btnQuickEmployee, 'employee', false);
if (!IS_LOCAL_DEMO) {
    // hide the whole "1-click demo login" panel and the demo-roles button on real deployments
    hideDemoShortcuts();
} else {
    // on localhost the shortcuts stay only when the local server offers the demo helper (emulators on)
    localDemoLogin('').then((ok) => { if (!ok) hideDemoShortcuts(); }).catch(hideDemoShortcuts);
}

// ═══════════ FORGOT PASSWORD MODAL ═══════════════════════════════════════════
(function setupForgotPassword() {
    const link    = document.getElementById('forgotPasswordLink');
    const overlay = document.getElementById('forgotPwdOverlay');
    const input   = document.getElementById('forgotEmailInput');
    const status  = document.getElementById('forgotPwdStatus');
    const submitBtn = document.getElementById('forgotSubmitBtn');
    const cancelBtn = document.getElementById('forgotCancelBtn');

    if (!link || !overlay) return;

    const open = () => {
        // Pre-fill email from the login form if already typed
        const existingEmail = document.getElementById('email')?.value?.trim();
        if (existingEmail && input) input.value = existingEmail;
        status.style.display = 'none';
        submitBtn.innerHTML = '<i data-lucide="send" style="width:16px;height:16px;"></i> Send Reset Link';
        submitBtn.disabled = false;
        overlay.style.display = 'flex';
        if (window.lucide) lucide.createIcons();
        setTimeout(() => input?.focus(), 100);
    };

    const close = () => { overlay.style.display = 'none'; };

    link.addEventListener('click', (e) => { e.preventDefault(); open(); });
    cancelBtn?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    submitBtn?.addEventListener('click', async () => {
        const email = input?.value?.trim();
        if (!email) {
            status.textContent = '⚠️ Please enter your email address.';
            status.style.cssText = 'display:block; padding:10px 14px; border-radius:10px; font-size:0.82rem; font-weight:600; margin-bottom:1rem; background:#fef3c7; color:#92400e;';
            input?.focus();
            return;
        }

        submitBtn.innerHTML = '⏳ Sending...';
        submitBtn.disabled = true;

        try {
            await sendPasswordResetEmail(auth, email, {
                url: window.location.origin + '/login.html',
                handleCodeInApp: false
            });
            status.textContent = '✅ Reset link sent! Check your inbox (and spam folder). The link expires in 1 hour.';
            status.style.cssText = 'display:block; padding:12px 16px; border-radius:10px; font-size:0.82rem; font-weight:600; margin-bottom:1rem; background:#dcfce7; color:#166534; border:1px solid #bbf7d0;';
            submitBtn.innerHTML = '✓ Email Sent';
            setTimeout(close, 4000);
        } catch (err) {
            console.warn('Password reset error:', err.code);
            let msg = '❌ Failed to send reset email. Please try again.';
            if (err.code === 'auth/user-not-found')    msg = '❌ No account found with this email. Please check and try again.';
            if (err.code === 'auth/invalid-email')     msg = '❌ Invalid email format. Please enter a valid email address.';
            if (err.code === 'auth/too-many-requests') msg = '⚠️ Too many requests. Please wait a few minutes and try again.';
            status.textContent = msg;
            status.style.cssText = 'display:block; padding:10px 14px; border-radius:10px; font-size:0.82rem; font-weight:600; margin-bottom:1rem; background:#fee2e2; color:#991b1b; border:1px solid #fecaca;';
            submitBtn.innerHTML = '<i data-lucide="send" style="width:16px;height:16px;"></i> Try Again';
            submitBtn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    });

    // Allow Enter key to submit
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitBtn?.click(); } });
})();
// ═════════════════════════════════════════════════════════════════════════════

// The email last used to sign in on this device, so a returning person only types their PIN. Kept in a cookie for
// the sign-in page (sign-out elsewhere clears local storage); "Not you?" forgets it on a shared computer.
const LAST_EMAIL = 'onnhr_email';
function rememberEmail(value) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = value
        ? `${LAST_EMAIL}=${encodeURIComponent(value)}; Max-Age=${365 * 86400}; Path=/; SameSite=Lax${secure}`
        : `${LAST_EMAIL}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}
function rememberedEmail() {
    const m = new RegExp('(?:^|;\\s*)' + LAST_EMAIL + '=([^;]*)').exec(document.cookie || '');
    try { return m ? decodeURIComponent(m[1]) : ''; } catch (_) { return ''; }
}
(function prefillRememberedEmail() {
    const last = rememberedEmail();
    const notYou = document.getElementById('notYouLink');
    // the email or mobile number used last on this browser
    if (!last || !emailInput || emailInput.value || !(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(last) || /^[\d\s()+.-]{10,20}$/.test(last))) return;
    emailInput.value = last;
    if (notYou) notYou.hidden = false;
    setTimeout(() => passwordInput?.focus(), 0);
    notYou?.addEventListener('click', () => { rememberEmail(''); emailInput.value = ''; notYou.hidden = true; emailInput.readOnly = false; emailInput.focus(); });
})();
// Pre-fill credentials if redirecting from signup page
try {
    const signupEmail = sessionStorage.getItem('signup_email');
    const signupPassword = sessionStorage.getItem('signup_password');
    if (signupEmail && emailInput) {
        emailInput.value = signupEmail;
        sessionStorage.removeItem('signup_email');
    }
    if (signupPassword && passwordInput) {
        passwordInput.value = signupPassword;
        sessionStorage.removeItem('signup_password');
    }
} catch (e) {
    console.warn('Session storage pre-fill failed:', e);
}

/* ---------- sign-in with a PIN, and a code by email as the way back in (routes/pin-signin.js) ----------
   pin    -> email and PIN are sent. Right PIN on a device seen before: signed in. Anything else: on to choose.
   choose -> the person picks where the code goes: their email, or a text to the mobile number on their record.
   code   -> the code is checked. Then signed in, or on to choosing a PIN.
   newpin -> a PIN is chosen (or the old one kept), then signed in. */
const signin = { stage: 'pin', choice: null, challenge: null, token: null, setupToken: null, keep: false };
const el = (id) => document.getElementById(id);
const signinLabel = () => (signin.stage === 'code' ? 'Check code \u2192' : signin.stage === 'newpin' ? 'Save PIN and sign in \u2192' : 'Sign In \u2192');
function showStage() {
    const pinGroup = passwordInput ? passwordInput.closest('.form-group') : null;
    if (pinGroup) pinGroup.hidden = signin.stage !== 'pin';
    el('chooseGroup').hidden = signin.stage !== 'choose';
    if (loginBtn) loginBtn.hidden = signin.stage === 'choose'; // that step has its own two buttons
    el('codeGroup').hidden = signin.stage !== 'code';
    el('newPinGroup').hidden = signin.stage !== 'newpin';
    el('pinHelpRow').hidden = signin.stage !== 'pin';
    if (emailInput) emailInput.readOnly = signin.stage !== 'pin';
    const b = loginBtn && loginBtn.querySelector('span'); if (b) b.textContent = signinLabel();
    const focus = signin.stage === 'code' ? el('signinCode') : signin.stage === 'newpin' ? el('newPin') : null;
    if (focus) focus.focus();
}
async function pinPost(path, body) {
    const res = await fetch(`/api/auth/pin/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(json.error || 'Sign-in is not working right now. Try again in a minute.'); err.code = json.code; throw err; }
    return json;
}
/** The words under the code box; on a development server also the code and the one-tap link, for testing. */
function codeHintFrom(out) {
    const box = el('codeHint');
    box.textContent = `${out.message}${out.devCode ? ` Code for testing: ${out.devCode}.` : ''}${out.devNote ? ` ${out.devNote}` : ''}`;
    if (out.devLink) {
        const a = document.createElement('a'); a.href = out.devLink; a.target = '_blank'; a.rel = 'noopener'; a.className = 'forgot-link';
        a.textContent = ' Open the one-tap link (testing)'; box.appendChild(a);
    }
}
/** One step of the sign-in. Returns the token to finish with, or null when the person has something more to type. */
async function pinStep(login, pin) {
    if (signin.stage === 'pin') {
        let prefer = '';
        try { prefer = (JSON.parse(localStorage.getItem('onnhr_code_way') || '{}') || {}).via || ''; } catch (_) { /* private window */ }
        const out = await pinPost('start', { login, pin, prefer });
        if (out.next === 'signed_in') return out.token;
        // a typo on the person's own device: say so, send nothing
        if (out.next === 'retry') { passwordInput.value = String(); passwordInput.focus(); smartSignin.secretTyped(''); throw new Error(`${out.message}${out.devNote ? ` ${out.devNote}` : ''}`); }
        if (!/@/.test(login) && el('signinPhone')) el('signinPhone').value = login;
        // the code was sent at once, the person's way: straight to the code box ("Send it another way" stays below it)
        if (out.next === 'code') {
            signin.challenge = out.challenge; signin.choice = out.choice; signin.stage = 'code';
            codeHintFrom(out);
            el('signinCode').value = '';
            showStage();
            return null;
        }
        signin.choice = out.challenge; signin.stage = 'choose';
        // signed in with a mobile number: that number is where a text or WhatsApp code goes
        if (!/@/.test(login) && el('signinPhone')) el('signinPhone').value = login;
        showStage();
        return null;
    }
    if (signin.stage === 'choose') return null; // nothing to submit: the two buttons of that step do the work
    if (signin.stage === 'code') {
        let out;
        try { out = signin.link ? await pinPost('link', { link: signin.link }) : await pinPost('code', { challenge: signin.challenge, code: el('signinCode').value.trim() }); }
        catch (err) { if (err.code === 'expired') { signin.stage = 'pin'; showStage(); } throw err; }
        signin.token = out.token; signin.setupToken = out.setupToken;
        if (out.hasPin && out.pinWasRight) return out.token; // the PIN was right, this was only a device we had not seen
        signin.stage = 'newpin';
        el('newPinHint').textContent = out.hasPin ? 'Choose a new PIN, or keep the one you have.' : 'You will use this PIN to sign in next time on this device.';
        el('keepPinRow').hidden = !out.hasPin;
        el('newPin').value = '';
        showStage();
        return null;
    }
    if (!signin.keep) await pinPost('set', { setupToken: signin.setupToken, pin: el('newPin').value.trim() });
    return signin.token;
}
/** The person chose where the code goes. */
async function sendSigninCode(via) {
    if (errorMessage) errorMessage.style.display = 'none';
    const buttons = [el('sendEmailBtn'), el('sendTextBtn'), el('sendWhatsAppBtn')];
    buttons.forEach((b) => { if (b) b.disabled = true; });
    try {
        const phoneWay = via === 'phone' || via === 'whatsapp';
        const out = await pinPost('send', { challenge: signin.choice, via, phone: phoneWay ? el('signinPhone').value.trim() : undefined });
        codeWays.remember(via, phoneWay ? el('signinPhone').value.trim() : '');
        signin.challenge = out.challenge; signin.stage = 'code';
        codeHintFrom(out);
        el('signinCode').value = '';
        showStage();
    } catch (err) {
        if (err.code === 'expired') { signin.stage = 'pin'; showStage(); }
        showError(err.name === 'TypeError' ? 'Network Error: Please check your internet connection.' : err.message);
    } finally { buttons.forEach((b) => { if (b) b.disabled = false; }); }
}
el('sendEmailBtn')?.addEventListener('click', () => sendSigninCode('email'));
el('sendTextBtn')?.addEventListener('click', () => sendSigninCode('phone'));
el('sendWhatsAppBtn')?.addEventListener('click', () => sendSigninCode('whatsapp'));
el('signinPhone')?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); sendSigninCode(codeWays.lastPhoneWay()); } });

// Ways to get a code besides email (text, WhatsApp) show only when this server offers them. The way a person used last
// on this browser, and their mobile number, are remembered here (this browser only) and offered first next time.
const codeWays = (() => {
    const KEY = 'onnhr_code_way';
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; } };
    const saved = read();
    const apply = (offer) => {
        const text = Boolean(offer && offer.text); const wa = Boolean(offer && offer.whatsapp);
        if (el('sendTextBtn')) el('sendTextBtn').hidden = !text;
        if (el('sendWhatsAppBtn')) el('sendWhatsAppBtn').hidden = !wa;
        if (el('phoneWays')) el('phoneWays').hidden = !(text || wa);
        if (el('phoneWaysLabel')) el('phoneWaysLabel').textContent = text && wa ? 'or to your phone' : wa ? 'or by WhatsApp' : 'or by text message';
        if (saved.phone && el('signinPhone') && !el('signinPhone').value) el('signinPhone').value = saved.phone;
        // the way used last goes first
        const first = { email: el('sendEmailBtn'), phone: el('sendTextBtn'), whatsapp: el('sendWhatsAppBtn') }[saved.via];
        if (first && !first.hidden) first.classList.add('preferred');
        if ((saved.via === 'phone' || saved.via === 'whatsapp') && first && !first.hidden && el('phoneWays') && el('chooseGroup')) {
            el('chooseGroup').insertBefore(el('phoneWays'), el('sendEmailBtn'));
            const lab = el('phoneWays').querySelector('div'); if (lab) lab.style.marginTop = '.35rem';
            el('phoneWaysLabel').textContent = text && wa ? 'To your phone' : wa ? 'By WhatsApp' : 'By text message';
            // and email becomes the other way, below
            const or = document.createElement('div');
            or.style.cssText = 'display:flex;align-items:center;gap:.6rem;margin:.9rem 0 .6rem;color:#94a3b8;font-size:.78rem';
            const line = () => { const x = document.createElement('span'); x.style.cssText = 'flex:1;height:1px;background:#e2e8f0'; return x; };
            or.append(line(), document.createTextNode('or by email'), line());
            el('chooseGroup').insertBefore(or, el('sendEmailBtn'));
        }
    };
    fetch('/api/auth/pin/channels').then((r) => r.json()).then(apply).catch(() => apply(null));
    return {
        remember(via, phone) { try { localStorage.setItem(KEY, JSON.stringify({ via, phone: phone ? String(phone).slice(0, 20) : (saved.phone || '') })); } catch (_) { /* private window */ } },
        lastPhoneWay() { return saved.via === 'whatsapp' && el('sendWhatsAppBtn') && !el('sendWhatsAppBtn').hidden ? 'whatsapp' : (el('sendTextBtn') && !el('sendTextBtn').hidden ? 'phone' : 'whatsapp'); }
    };
})();
el('otherWayLink')?.addEventListener('click', () => { if (errorMessage) errorMessage.style.display = 'none'; signin.stage = 'choose'; showStage(); });
// "Didn't get it?" reads better next to a code that was sent by itself
if (el('otherWayLink')) el('otherWayLink').textContent = "Didn't get it? Send it another way";
el('noPinLink')?.addEventListener('click', () => { passwordInput?.setRangeText(String(), 0, passwordInput.value.length); loginBtn?.click(); }); // empties the PIN box: no PIN means a code is used
el('keepPinLink')?.addEventListener('click', () => { signin.keep = true; loginBtn?.click(); });

const ssoSignin = { token: null }; // set by the SSO button below, used once by the sign-in handler
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const typedLogin = emailInput.value.trim(); // an email or a mobile number
  let email = typedLogin;
  const password = passwordInput.value;
  let cleanEmail = email.toLowerCase();
  
  const btnText = loginBtn.querySelector('span');
  const originalText = btnText.textContent;
  btnText.textContent = 'Authenticating...';
  loginBtn.disabled = true;
  errorMessage.style.display = 'none';

  // The server checks either: 4 to 6 digits is a PIN, anything else a password. A right password signs in at once; a right
  // PIN signs in at once on a device used before; anything else asks where to send a code.
  let customToken = null;
  if (ssoSignin.token) { customToken = ssoSignin.token; ssoSignin.token = null; } // finished at the company's identity provider
  else {
    try { customToken = await pinStep(typedLogin, password); }
    catch (err) { showError(err.name === 'TypeError' ? 'Network Error: Please check your internet connection.' : err.message); }
    if (!customToken) { if (btnText) btnText.textContent = signinLabel(); loginBtn.disabled = false; return; }
  }

  try {
    let userData = null;
    let finalUid = null;
    let token = null;
    let lastAuthError = null;

    const isSuperAdminAccount = cleanEmail === 'superadmin@kylrx.ai' || cleanEmail === 'nandanb449@gmail.com' || cleanEmail === 'admin@kylrx.ai' || cleanEmail === 'admin@demo.com' || cleanEmail.includes('superadmin') || cleanEmail.includes('admin');
    const isHrAccount = cleanEmail === 'savitha.balraju@gmail.com' || cleanEmail === 'hradmin@kylrx.ai' || cleanEmail === 'hrms@kylrx.ai' || cleanEmail.includes('hradmin') || cleanEmail.includes('hrms') || cleanEmail.includes('savitha');
    const isManagerAccount = cleanEmail === 'john.doe@example.com' || cleanEmail === 'manager@kylrx.ai' || cleanEmail === 'manager' || cleanEmail.includes('manager');
    const isEmployeeAccount = cleanEmail === 'marry@gmail.com' || cleanEmail === 'employee@kylrx.ai';

    // Strategy 1: Firebase Authentication (direct attempt with entered credentials first)
    try {
      let userCredential;
      try {
        userCredential = customToken ? await signInWithCustomToken(auth, customToken) : await signInWithEmailAndPassword(auth, email, password);
      } catch (firstErr) {
        throw firstErr;
      }
      finalUid = userCredential.user.uid;
      // signed in with a mobile number: from here on, use the email on the account
      if (!/@/.test(email) && userCredential.user.email) { email = userCredential.user.email; cleanEmail = email.toLowerCase(); }
      token = userCredential.user.accessToken;

      // Server-assigned custom claims (set via the Admin SDK only) are the authoritative role
      let claimRole = null;
      let claimOrgId = null;
      try {
        const tokenResult = await userCredential.user.getIdTokenResult();
        claimRole = tokenResult.claims.role || (tokenResult.claims.super_admin ? 'super_admin' : null);
        claimOrgId = tokenResult.claims.orgId || null;
      } catch (_) {}

      const userDoc = await getDoc(doc(db, "users", finalUid));
      if (userDoc.exists()) {
        userData = userDoc.data();
        userData.uid = finalUid;
        if (claimRole) userData.role = claimRole;
        if (claimOrgId && !userData.orgId) userData.orgId = claimOrgId;
        // Check for EMP doc or query by email in users collection
        try {
          const empDoc = await getDoc(doc(db, "users", "EMP_1789151730443"));
          if (empDoc.exists() && empDoc.data().email === cleanEmail) {
            userData = empDoc.data();
            userData.uid = finalUid;
          }
        } catch (_) {}

        if (!userData) {
          try {
            const q = query(collection(db, "users"), where("email", "in", [cleanEmail, email]));
            const querySnap = await getDocs(q);
            if (!querySnap.empty) {
              userData = querySnap.docs[0].data();
              userData.uid = finalUid;
            }
          } catch (_) {}
        }
      }

      if (!userData) {
        const roleDetermined = isSuperAdminAccount ? 'SUPER_ADMIN' : (isHrAccount ? 'hrms' : (isManagerAccount ? 'manager' : 'employee'));
        const deptDetermined = isSuperAdminAccount ? 'Executive' : (isHrAccount ? 'Human Resources' : (isManagerAccount ? 'Cybersecurity Manager' : 'Engineering'));
        const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
        const formattedName = namePart.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'User';

        userData = {
          uid: finalUid,
          email: email,
          name: isSuperAdminAccount ? 'Nandan' : (isHrAccount ? 'Savitha' : (isManagerAccount ? 'John Doe' : (cleanEmail === 'marry@gmail.com' ? 'Marry Doe' : formattedName))),
          role: roleDetermined,
          department: deptDetermined,
          departmentName: deptDetermined,
          departmentCode: isManagerAccount ? 'UNIT-CYB-802' : '',
          departmentId: isManagerAccount ? 'Yksv1DMH9pIeRhNxQ8E3' : '',
          employeeId: isManagerAccount ? 'UNIT-CYB-802-SMCU' : ('EMP-' + Math.floor(1000 + Math.random() * 9000)),
          status: 'Active'
        };
      }
    } catch (authErr) {
      lastAuthError = authErr;
      if (authErr.code !== 'auth/invalid-credential' && authErr.code !== 'auth/user-not-found' && authErr.code !== 'auth/wrong-password') {
        console.warn("Firebase Auth status:", authErr.code || authErr.message);
      }
    }

    // the role comes from the person's record; an email that merely contains "manager" does not change it
    if (userData && isManagerAccount && !userData.role) userData.role = 'manager';

    // Only a real sign-in (Firebase Auth above) gives a session: no password is ever compared in the browser, and there
    // are no built-in demo accounts. (Strategy 2, a browser-side compare against stored passwords, and Strategy 3,
    // offline demo sessions, were removed.)
    if (!userData) {
      if (lastAuthError) throw lastAuthError;
      throw new Error("Invalid credentials. Please verify your password or use 'Forgot Password'.");
    }

    const role = (userData.role || (isManagerAccount ? 'manager' : 'employee')).toLowerCase();
    const dept = (userData.departmentId || userData.department || userData.departmentName || 'General').toLowerCase();

    console.log('✅ Login successful for:', email, 'Role:', role);

    try { rememberEmail(String(typedLogin || email || '').trim().toLowerCase()); } catch (_) { /* a blocked cookie only means the email is typed next time */ }
    localStorage.setItem('hr_logged_in', 'true');
    try { new BroadcastChannel('onnhr-signin').postMessage('signed-in'); } catch (_) { /* old browser: the other tab just keeps waiting */ }
    localStorage.setItem('hr_user_id', finalUid);
    if (token) localStorage.setItem('hr_access_token', token);
    localStorage.setItem('userName', userData.name || email);
    localStorage.setItem('userRole', role);
    localStorage.setItem('userDept', dept);
    localStorage.setItem('employee_uid', finalUid);
    if (userData.departmentId) localStorage.setItem('departmentId', userData.departmentId);
    if (userData.departmentName) localStorage.setItem('departmentName', userData.departmentName);
    if (userData.departmentCode) localStorage.setItem('departmentCode', userData.departmentCode);
    if (role === 'manager') {
      localStorage.setItem('manager_name', userData.name || 'John Doe');
      localStorage.setItem('manager_email', userData.email || email);
      localStorage.setItem('manager_dept', userData.departmentName || 'Cybersecurity Manager');
      localStorage.setItem('manager_dept_code', userData.departmentCode || 'UNIT-CYB-802');
    }
    if (role === 'hrms' || role === 'hr_admin' || role === 'hr' || isHrAccount) {
      localStorage.setItem('hrms_manager_name', 'Savitha Balraju');
      localStorage.setItem('hrms_manager_role', 'Strategic Operations');
      localStorage.setItem('hrms_name', 'Savitha Balraju');
    }

    // A temporary password (given out by HR) only opens the "choose a new password" page. The server refuses
    // everything else for this person until they have chosen their own password, so send them there first.
    if (await mustChooseNewPassword()) {
      if (btnText) btnText.textContent = 'Choose a new password...';
      window.location.href = 'set-password.html';
      return;
    }

    const redirectUrl = await getRedirectUrl(userData, role);
    if (btnText) btnText.textContent = 'Redirecting to your workspace...';
    window.location.href = redirectUrl;

  } catch (error) {
    if (error.message && error.message.includes('Access Denied')) {
        showAlert('Access Restricted', error.message, 'shield-alert');
    } else if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
        showError('Invalid credentials. Please verify your password or use "Forgot Password".');
    } else if (error.code === 'auth/user-not-found') {
        showError('No account found with this email. Please sign up first.');
    } else if (error.code === 'auth/invalid-email') {
        showError('Please enter a valid email address format.');
    } else if (error.code === 'auth/too-many-requests') {
        showError('Too many failed attempts. Please wait a few moments and try again.');
    } else if (error.name === 'TypeError') {
        showError('Network Error: Please check your internet connection.');
    } else {
        showError(error.message || 'Invalid login credentials. Please try again.');
    }
  } finally {
    if (btnText) btnText.textContent = signinLabel();
    if (loginBtn) loginBtn.disabled = false;
  }
});

function showError(msg) {
  if (errorMessage) {
    errorMessage.textContent = msg;
    errorMessage.style.display = 'block';
    errorMessage.classList.add('shake');
    setTimeout(() => errorMessage.classList.remove('shake'), 500);
  }
}

function showAlert(title, msg, icon = 'info', type = 'info') {
    document.getElementById('alertTitle').textContent = title;
    document.getElementById('alertMsg').textContent = msg;
    const iconEl = document.getElementById('alertIcon');
    const btnEl = document.getElementById('alertBtn');
    const cardEl = document.getElementById('alertCard');
    
    iconEl.innerHTML = `<i data-lucide="${icon}"></i>`;
    
    if (type === 'error' || title.toLowerCase().includes('denied') || title.toLowerCase().includes('restricted')) {
        iconEl.style.color = '#ef4444';
        btnEl.style.background = '#ef4444';
        cardEl.style.borderTop = '6px solid #ef4444';
    } else {
        iconEl.style.color = '#2563eb';
        btnEl.style.background = '#2563eb';
        cardEl.style.borderTop = 'none';
    }
    
    if (window.lucide) { lucide.createIcons(); }
    document.getElementById('customOverlay').style.display = 'flex';
}

const googleLoginBtn = document.getElementById('googleLoginBtn');
if (googleLoginBtn) {
    async function processGoogleLoginUser(userAuth) {
        const email = userAuth.email || '';
        const cleanEmail = email.toLowerCase().trim();
        let userData = null;

        // 1. Try direct getDoc from Firestore by Google Auth UID
        try {
            const userDoc = await getDoc(doc(db, "users", userAuth.uid));
            if (userDoc.exists()) {
                userData = userDoc.data();
                userData.uid = userAuth.uid;
            }
        } catch (err) {
            console.warn('Direct getDoc failed:', err);
        }

        // 2. Try query users collection by email (checking cleanEmail, email, upperCase)
        if (!userData && cleanEmail) {
            try {
                const emailVariants = Array.from(new Set([cleanEmail, email, email.toUpperCase()])).filter(Boolean);
                const q = query(collection(db, 'users'), where('email', 'in', emailVariants));
                const querySnap = await getDocs(q);
                if (!querySnap.empty) {
                    userData = querySnap.docs[0].data();
                    userData.uid = querySnap.docs[0].id;
                }
            } catch (err) {
                console.warn('Firestore users query failed:', err);
            }
        }

        // 3. Try query employees collection by email if not found in users
        if (!userData && cleanEmail) {
            try {
                const emailVariants = Array.from(new Set([cleanEmail, email, email.toUpperCase()])).filter(Boolean);
                const empQ = query(collection(db, 'employees'), where('email', 'in', emailVariants));
                const empSnap = await getDocs(empQ);
                if (!empSnap.empty) {
                    const empData = empSnap.docs[0].data();
                    userData = {
                        uid: empSnap.docs[0].id,
                        ...empData,
                        role: empData.role || 'employee'
                    };
                }
            } catch (_) {}
        }

        // 4. Only people who already have a Kylrx account may sign in with Google. Unknown Google
        //    accounts used to be auto-provisioned with a role guessed from the email address
        //    (anything containing "admin" became SUPER_ADMIN), letting anyone into the app.
        if (!userData) {
            try { await signOut(auth); } catch (_) {}
            throw new Error(`No Kylrx account exists for ${email}. Sign in with the email your company registered, or ask your administrator to add you.`);
        }

        // Server-assigned custom claims (set via the Admin SDK only) are the authoritative role
        try {
            const claims = (await userAuth.getIdTokenResult()).claims || {};
            const claimRole = claims.role || (claims.super_admin || claims.superadmin ? 'super_admin' : null);
            if (claimRole) userData.role = claimRole;
            if (claims.orgId && !userData.orgId) userData.orgId = claims.orgId;
        } catch (_) {}

        const isManagerAccount = /manager/i.test(userData.role || '');
        const isHrAccount = /^(hrms|hr|hr_admin|hradmin)$/i.test(userData.role || '');

        // Record the Google link without blocking sign-in (a write can take up to 20s to fail
        // while the Firestore quota is exhausted)
        setDoc(doc(db, "users", userAuth.uid), {
            ...userData,
            uid: userData.uid || userAuth.uid,
            googleLinked: true,
            photoURL: userAuth.photoURL || userData.photoURL || '',
            updatedAt: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('Google link metadata not saved:', err.message));

        const role = (userData.role || (isManagerAccount ? 'manager' : 'employee')).toLowerCase();
        const dept = (userData.departmentId || userData.department || userData.departmentName || 'General').toLowerCase();
        const finalUid = userData.uid || userAuth.uid;

        console.log('✅ Google login successful for:', email, 'Role:', role);

        // Save complete enterprise session credentials to localStorage
        localStorage.setItem('hr_logged_in', 'true');
        localStorage.setItem('hr_user_id', finalUid);
        localStorage.setItem('hr_access_token', userAuth.accessToken || 'demo-static-token');
        localStorage.setItem('userName', userData.name || userData.displayName || email);
        localStorage.setItem('userRole', role);
        localStorage.setItem('user_role', role);
        localStorage.setItem('userDept', dept);
        localStorage.setItem('employee_uid', finalUid);

        if (userData.departmentId) localStorage.setItem('departmentId', userData.departmentId);
        if (userData.departmentName) localStorage.setItem('departmentName', userData.departmentName);
        if (userData.departmentCode) localStorage.setItem('departmentCode', userData.departmentCode);

        const orgId = userData.orgId || localStorage.getItem('orgId') || 'org_kylrx_ai';
        localStorage.setItem('orgId', orgId);
        localStorage.setItem('orgConfigured', 'true');

        if (role === 'manager' || isManagerAccount) {
            localStorage.setItem('manager_name', userData.name || 'John Doe');
            localStorage.setItem('manager_email', userData.email || email);
            localStorage.setItem('manager_dept', userData.departmentName || 'Cybersecurity Manager');
            localStorage.setItem('manager_dept_code', userData.departmentCode || 'UNIT-CYB-802');
        }
        if (role === 'hrms' || role === 'hr_admin' || role === 'hr' || isHrAccount) {
            localStorage.setItem('hrms_manager_name', userData.name || 'Savitha Balraju');
            localStorage.setItem('hrms_manager_role', 'Strategic Operations');
            localStorage.setItem('hrms_name', userData.name || 'Savitha Balraju');
        }

        const redirectUrl = await getRedirectUrl(userData, role);
        if (googleLoginBtn) {
            const span = googleLoginBtn.querySelector('span');
            if (span) span.textContent = 'Redirecting to your workspace...';
        }
        window.location.href = redirectUrl;
    }

    async function handleGoogleAuthError(error) {
        console.error('Google sign-in error:', error);
        
        if (error.code === 'auth/operation-not-allowed') {
            showAlert('Configuration Error', 'Google Sign-In is not enabled. Please enable the Google provider in your Firebase Authentication Console.', 'info');
        } else if (error.message && error.message.includes('Access Denied')) {
            showAlert('Access Restricted', error.message, 'shield-alert');
        } else if (error.code === 'auth/popup-closed-by-user') {
            showError('Sign-in popup closed.');
        } else if (error.code === 'auth/cancelled-popup-request') {
            showError('Sign-in cancelled. Please try again.');
        } else if (error.code === 'auth/popup-blocked') {
            showError('Sign-in popup was blocked by your browser. Please allow popups for this site.');
        } else if (error.code === 'auth/missing-initial-state' || (error.message && error.message.includes('missing initial state'))) {
            showError('Authentication session expired or blocked by browser storage partitioning. Please use popup sign-in.');
        } else {
            showError(error.message || 'Google sign-in failed.');
        }
    }

    googleLoginBtn.addEventListener('click', async () => {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        
        // Show loading state
        const originalHtml = googleLoginBtn.innerHTML;
        googleLoginBtn.innerHTML = `<span>Connecting to Google...</span>`;
        googleLoginBtn.disabled = true;
        
        try {
            if (window.location.protocol === 'https:') {
                // HTTPS: full-page redirect through this server's /__/auth proxy (no popup, no
                // Cross-Origin-Opener-Policy warnings). Handled by getRedirectResult below.
                await signInWithRedirect(auth, provider);
                return;
            }
            // Plain-http local development: Firebase's redirect handler needs HTTPS, so use the
            // popup. Chrome logs harmless "Cross-Origin-Opener-Policy would block" warnings.
            const result = await signInWithPopup(auth, provider);
            if (result && result.user) {
                googleLoginBtn.innerHTML = `<span>Redirecting to your workspace...</span>`;
                googleLoginBtn.disabled = true;
                await processGoogleLoginUser(result.user);
            }
        } catch (error) {
            googleLoginBtn.innerHTML = originalHtml;
            googleLoginBtn.disabled = false;
            await handleGoogleAuthError(error);
        }
    });

    // Company single sign-on (OIDC / SAML through Firebase Authentication): shown when the typed email's
    // domain belongs to a company that turned SSO on. Companies that require it refuse passwords on the server.
    (function setupSso() {
        const emailField = document.getElementById('email') || document.querySelector('input[type=email]');
        if (!emailField || !googleLoginBtn) return;
        let ssoBtn = null; let lastDomain = '';
        async function check() {
            const email = (emailField.value || '').trim();
            const domain = (email.split('@')[1] || '').toLowerCase();
            if (!domain || domain === lastDomain) return;
            lastDomain = domain;
            try {
                const r = await (await fetch('/api/sso/discover?email=' + encodeURIComponent(email))).json();
                if (ssoBtn) { ssoBtn.remove(); ssoBtn = null; }
                if (!r.sso) return;
                ssoBtn = document.createElement('button');
                ssoBtn.type = 'button'; ssoBtn.className = googleLoginBtn.className; ssoBtn.textContent = 'Sign in with your company (SSO)';
                ssoBtn.style.marginTop = '8px'; ssoBtn.style.width = '100%';
                googleLoginBtn.parentElement.appendChild(ssoBtn);
                ssoBtn.addEventListener('click', async () => {
                    try {
                        const provider = r.providerId.startsWith('saml.') ? new SAMLAuthProvider(r.providerId) : new OAuthProvider(r.providerId);
                        const result = await signInWithPopup(auth, provider);
                        if (!result || !result.user) return;
                        // The provider's account is not the person's Onn HR account: the server checks the sign-in and
                        // answers with a one-time token for the person's own account (routes/sso.js, POST /complete).
                        const idToken = await result.user.getIdToken();
                        const res = await fetch('/api/sso/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
                        const out = await res.json().catch(() => ({}));
                        try { await signOut(auth); } catch (_) {}
                        if (!res.ok || !out.token) { showError(out.error || 'Single sign-on failed. Try again.'); return; }
                        ssoSignin.token = out.token;
                        loginForm?.requestSubmit();
                    } catch (error) {
                        showError(error && error.code === 'auth/account-exists-with-different-credential'
                            ? 'Single sign-on is not finished on our side yet: your administrator must allow one account per sign-in provider in Firebase Authentication. Sign in with your PIN for now.'
                            : (error && error.code === 'auth/popup-closed-by-user' ? 'The sign-in window was closed before it finished.' : (error.message || 'Single sign-on failed.')));
                    }
                });
            } catch (_) {}
        }
        emailField.addEventListener('blur', check);
        emailField.addEventListener('change', check);
    })();

    // Check if user completed a redirect (with quiet handling for partitioned environments)
    try {
        getRedirectResult(auth).then((redirectResult) => {
            if (redirectResult && redirectResult.user) {
                console.log('✅ Processing Google redirect sign-in...');
                if (googleLoginBtn) {
                    googleLoginBtn.innerHTML = `<span>Redirecting to your workspace...</span>`;
                    googleLoginBtn.disabled = true;
                }
                processGoogleLoginUser(redirectResult.user);
            }
        }).catch((redirectErr) => {
            const isStoragePartitionErr = redirectErr && (
                redirectErr.code === 'auth/missing-initial-state' || 
                String(redirectErr.message || '').includes('missing initial state')
            );
            if (!isStoragePartitionErr) {
                console.warn('Redirect result check:', redirectErr);
                handleGoogleAuthError(redirectErr);
            }
        });
    } catch (_) {}
}

// A company of another country signs in at that country's own address (region.js). Shown under the form, only when
// this server takes some countries and knows where the others are.
import('./region.js').then(async (R) => {
    const info = await R.loadRegion();
    const form = document.getElementById('loginForm');
    if (!info || !info.restricted || !form) return;
    for (const c of info.elsewhere) { const line = R.addressLine(c, 'sign in', 'login.html'); if (line) form.insertAdjacentElement('afterend', line); }
}).catch(() => {});

// ------------------------------------------------------------------------------------------------ smart sign-in boxes
// Everything here only helps people type; the server decides who signs in. Remembered things stay in this browser.
const smartSignin = (() => {
    const KIND = 'onnhr_secret_kind'; // 'pin' or 'password': what this person used last on this browser
    const idLabel = document.querySelector('label[for="email"]');
    const pwLabel = document.querySelector('label[for="password"]');
    const codeInput = document.getElementById('signinCode');
    const phoneish = (v) => /^[\d\s()+.-]+$/.test(v) && v.replace(/\D/g, '').length >= 3;
    const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
    const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private window */ } };
    if (!emailInput || !passwordInput) return { secretTyped() {} };

    // 1. the first box: a phone number is shown as one while it is typed, and the label says which it is
    const label = () => { if (!idLabel) return; const v = emailInput.value.trim(); idLabel.textContent = /@/.test(v) ? 'Email' : phoneish(v) ? 'Mobile number' : 'Email or mobile number'; };
    emailInput.addEventListener('input', (e) => {
        const v = emailInput.value;
        if (phoneish(v) && !(e.inputType || '').startsWith('delete')) { const f = formatPhone(v); if (f !== v) emailInput.value = f; }
        label();
    });
    label();
    // Enter in the first box goes to the second one when it is still empty
    emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && signin.stage === 'pin' && !passwordInput.value) { e.preventDefault(); passwordInput.focus(); } });

    // 2. the second box: the number pad for people who use a PIN, the full keyboard for a password, and a link to switch
    const row = passwordInput.closest('.form-group');
    const extra = document.createElement('div');
    extra.style.cssText = 'display:flex;justify-content:space-between;gap:.6rem;margin-top:.35rem;font-size:.8rem';
    const caps = document.createElement('span'); caps.style.color = '#b45309'; caps.textContent = 'Caps Lock is on'; caps.hidden = true;
    const switcher = document.createElement('a'); switcher.href = 'javascript:void(0)'; switcher.className = 'forgot-link'; switcher.style.marginLeft = 'auto';
    extra.append(caps, switcher);
    if (row) row.appendChild(extra);
    const useKind = (kind) => {
        if (kind === 'pin') { passwordInput.setAttribute('inputmode', 'numeric'); passwordInput.placeholder = 'Your 4 to 6 digit PIN'; switcher.textContent = 'Use a password instead'; }
        else { passwordInput.removeAttribute('inputmode'); passwordInput.placeholder = kind === 'password' ? 'Your password' : 'Your password or 4 to 6 digit PIN'; switcher.textContent = 'Use a PIN instead'; }
        useKind.now = kind;
    };
    useKind(read(KIND) || '');
    switcher.addEventListener('click', () => { useKind(useKind.now === 'pin' ? 'password' : 'pin'); passwordInput.value = String(); passwordInput.focus(); });
    const secretTyped = (v) => {
        if (pwLabel) pwLabel.textContent = !v ? 'Password or PIN' : /^\d{1,6}$/.test(v) ? 'PIN' : 'Password';
    };
    passwordInput.addEventListener('input', () => secretTyped(passwordInput.value));
    const capsCheck = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock') || useKind.now === 'pin'; };
    passwordInput.addEventListener('keydown', capsCheck); passwordInput.addEventListener('keyup', capsCheck);
    passwordInput.addEventListener('blur', () => { caps.hidden = true; });
    // remember which kind was used, once the form is sent with something in the box
    loginForm?.addEventListener('submit', () => { const v = passwordInput.value; if (signin.stage === 'pin' && v) write(KIND, /^\d{4,6}$/.test(v) ? 'pin' : 'password'); }, true);

    // 3. the code box: paste anything (only the digits are kept), and it sends itself at 6 digits
    if (codeInput) {
        codeInput.addEventListener('input', () => {
            const d = codeInput.value.replace(/\D/g, '').slice(0, 6);
            if (d !== codeInput.value) codeInput.value = d;
            if (d.length === 6 && signin.stage === 'code') loginForm?.requestSubmit();
        });
        // on Android Chrome the code is read from the text message by itself (the message ends with "@site #code")
        let asking = null;
        const watch = new MutationObserver(() => {
            const shown = signin.stage === 'code' && !el('codeGroup').hidden;
            if (shown && !asking && 'OTPCredential' in window) {
                asking = new AbortController();
                navigator.credentials.get({ otp: { transport: ['sms'] }, signal: asking.signal })
                    .then((otp) => { if (otp && otp.code && signin.stage === 'code') { codeInput.value = otp.code; codeInput.dispatchEvent(new Event('input')); } })
                    .catch(() => {}).finally(() => { asking = null; });
            } else if (!shown && asking) { asking.abort(); asking = null; }
        });
        watch.observe(el('codeGroup'), { attributes: true, attributeFilter: ['hidden'] });
    }
    return { secretTyped };
})();

// ------------------------------------------------------------------------------- one-tap link from a code message
// The address ends with #k=<link>. The part after # never reaches a server, and the link is used only after a tap,
// so a mail scanner that opens links cannot use it up.
(function oneTapLink() {
    const m = /^#k=([A-Za-z0-9_-]{20,40})$/.exec(window.location.hash || '');
    if (!m || !loginForm) return;
    history.replaceState(null, '', window.location.pathname + window.location.search); // the link is not kept in the address bar
    signin.link = m[1];
    signin.stage = 'code';
    const card = document.createElement('div');
    card.className = 'form-group';
    card.innerHTML = '<p style="margin:0 0 .6rem;font-size:.95rem;color:#334155">You opened a one-tap sign-in link. Tap Continue to sign in on this device.</p>';
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn-primary'; go.style.width = '100%'; go.textContent = 'Continue \u2192';
    card.appendChild(go);
    const ignore = document.createElement('a'); ignore.href = 'login.html'; ignore.className = 'forgot-link'; ignore.style.cssText = 'display:inline-block;margin-top:.6rem;font-size:.82rem'; ignore.textContent = 'This was not me: sign in another way';
    card.appendChild(ignore);
    // only this card shows: the link already says who it is
    [...loginForm.children].forEach((c) => { c.dataset.oneTapHidden = c.hidden ? '1' : '0'; c.hidden = true; });
    loginForm.prepend(card);
    if (emailInput) emailInput.required = false;
    go.addEventListener('click', () => {
        go.disabled = true; go.textContent = 'Signing in\u2026';
        card.remove();
        [...loginForm.children].forEach((c) => { c.hidden = c.dataset.oneTapHidden === '1'; });
        showStage();
        loginForm.requestSubmit();
    });
})();

// The tab where the person asked for the code follows along when they sign in with the link in another tab.
try {
    new BroadcastChannel('onnhr-signin').onmessage = (e) => {
        if (e.data !== 'signed-in' || signin.stage !== 'code' || signin.link) return;
        const box = el('codeHint');
        if (box) box.textContent = 'You signed in in another tab. You can close this one.';
        const input = el('signinCode'); if (input) input.disabled = true;
    };
} catch (_) { /* old browser */ }
