/**
 * Onn HR - Manager Portal Navigation & Isolation Guard
 * Enforces strict boundary isolation: prevents any navigation from Manager Command Center
 * to Admin, HRMS, or Employee portal pages.
 */
(function() {
    'use strict';

    // Target portal patterns that a Manager must NEVER navigate to
    const FORBIDDEN_TARGETS = [
        /^admin[-_.]/i,
        /^admin\b/i,
        /^hrms[-_.]/i,
        /^hrms\b/i,
        /^employee[-_.]/i,
        /^employee\b/i,
        /payroll[-_.]/i,
        /statutory[-_.]/i,
        /bulk-trigger/i,
        /controls-acceptance/i
    ];

    function isForbidden(url) {
        if (!url || typeof url !== 'string') return false;
        const clean = url.trim();
        if (clean.startsWith('#') || clean.startsWith('javascript:') || clean.startsWith('mailto:') || clean.startsWith('tel:')) {
            return false;
        }

        // Allow styling, scripts, and media
        if (/\.(css|js|json|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2)$/i.test(clean.split('?')[0])) {
            return false;
        }

        // Allow allowed manager pages and authentication pages
        if (/^manager[-_.]/i.test(clean) || clean === 'index.html' || clean === 'login.html') {
            return false;
        }

        // Extract filename from URL/path
        let filename = clean;
        try {
            if (clean.startsWith('http://') || clean.startsWith('https://')) {
                const u = new URL(clean, window.location.origin);
                // Allow external SaaS applications (Slack, Github, Jira, Google, etc.)
                const isInternalHost = (u.hostname === window.location.hostname || u.hostname === '127.0.0.1' || u.hostname === 'localhost');
                if (!isInternalHost) {
                    return false;
                }
                const parts = u.pathname.split('/').filter(Boolean);
                filename = parts[parts.length - 1] || '';
            } else {
                const parts = clean.split('?')[0].split('#')[0].split('/').filter(Boolean);
                filename = parts[parts.length - 1] || clean;
            }
        } catch (e) {
            filename = clean;
        }

        return FORBIDDEN_TARGETS.some(rx => rx.test(filename));
    }

    function showAccessRestrictedToast(targetUrl) {
        const existing = document.getElementById('mgrNavRestrictedToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'mgrNavRestrictedToast';
        toast.setAttribute('role', 'alert');
        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 999999;
            background: #0f172a;
            color: #ffffff;
            padding: 16px 20px;
            border-radius: 16px;
            box-shadow: 0 20px 40px -10px rgba(15, 23, 42, 0.4), 0 0 0 1px rgba(239, 68, 68, 0.35);
            display: flex;
            align-items: center;
            gap: 14px;
            max-width: 440px;
            font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            animation: mgrSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        `;

        toast.innerHTML = `
            <div style="width: 38px; height: 38px; border-radius: 10px; background: rgba(239, 68, 68, 0.15); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: #ef4444; font-size: 20px;">
                🛡️
            </div>
            <div style="flex: 1;">
                <div style="font-weight: 700; font-size: 0.9rem; color: #f87171; letter-spacing: -0.2px;">Cross-Portal Navigation Restricted</div>
                <div style="font-size: 0.78rem; color: #94a3b8; margin-top: 3px; line-height: 1.35;">
                    Manager Command Center is restricted from navigating to Admin, HRMS, or Employee portals.
                </div>
            </div>
            <button onclick="this.parentElement.remove()" style="background: none; border: none; color: #64748b; font-size: 18px; cursor: pointer; padding: 4px; line-height: 1;">✕</button>
        `;

        if (!document.getElementById('mgrNavRestrictedStyles')) {
            const st = document.createElement('style');
            st.id = 'mgrNavRestrictedStyles';
            st.textContent = `
                @keyframes mgrSlideUp {
                    from { opacity: 0; transform: translateY(16px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `;
            document.head.appendChild(st);
        }

        document.body.appendChild(toast);
        setTimeout(() => {
            if (toast && toast.parentNode) {
                toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(10px)';
                setTimeout(() => toast.remove(), 400);
            }
        }, 5000);
    }

    // 1. Intercept all link clicks and element navigations (capturing phase)
    document.addEventListener('click', function(e) {
        const anchor = e.target.closest('a[href], [data-href]');
        if (!anchor) return;

        const href = anchor.getAttribute('href') || anchor.getAttribute('data-href');
        if (href && isForbidden(href)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            console.warn('[Manager Boundary Guard] Blocked cross-portal navigation to:', href);
            showAccessRestrictedToast(href);
            return false;
        }
    }, true);

    // 2. Wrap programmatic navigation methods (window.open, location.assign, location.replace)
    try {
        const origOpen = window.open;
        window.open = function(url, ...args) {
            if (url && isForbidden(url)) {
                console.warn('[Manager Boundary Guard] Blocked window.open to:', url);
                showAccessRestrictedToast(url);
                return null;
            }
            return origOpen.call(window, url, ...args);
        };
    } catch(err) {}

    // Expose validation helper globally for form submissions / custom apps
    window.isForbiddenManagerNavigation = isForbidden;
    window.showManagerRestrictedToast = showAccessRestrictedToast;
})();
