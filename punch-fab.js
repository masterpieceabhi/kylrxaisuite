/**
 * A round clock button on every signed-in page, for every role, that opens the clock in/out page.
 * A green dot shows when the person is clocked in. Shown for US/CA companies only (India keeps its
 * own attendance screens). Loaded from firebase-config.js.
 */
import { auth, onAuthStateChanged } from './firebase-config.js';

const SKIP = /\/(login|signup|index|punch|kiosk|employee-login|hrms-login|manager-login|onboarding-invite|onboarding-wizard|us-onboarding)\.html$|\/$/;

function mount(state) {
  if (document.getElementById('punchFab')) return;
  const a = document.createElement('a');
  a.id = 'punchFab';
  a.href = 'punch.html';
  a.setAttribute('aria-label', state === 'out' ? 'Clock in or out' : 'You are clocked in. Open clock');
  a.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;width:60px;height:60px;border-radius:50%;background:#0f172a;color:#fff;display:grid;place-items:center;box-shadow:0 8px 22px rgba(15,23,42,.35);text-decoration:none';
  a.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
    + `<span id="punchFabDot" style="position:absolute;top:4px;right:4px;width:16px;height:16px;border-radius:50%;border:2px solid #fff;background:${state === 'out' ? '#94a3b8' : '#22c55e'}"></span>`;
  document.body.appendChild(a);
}

if (!SKIP.test(window.location.pathname)) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/time/status', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const json = await res.json();
      if (json.country === 'IN') return;
      mount(json.status.state);
    } catch (_) {}
  });
}
