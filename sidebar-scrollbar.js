/**
 * Onn HR - Custom Persistent Manager Sidebar Scrollbar
 * Provides an always-visible, draggable custom scrollbar with
 * top (▲) and bottom (▼) scroll arrow buttons for all Manager Dashboards.
 */
(function() {
    function initSidebarScrollbar() {
        const sidebar = document.querySelector('.sidebar') || document.querySelector('#sidebar');
        if (!sidebar) return;

        const navMenu = sidebar.querySelector('.nav-menu') || sidebar.querySelector('.sidebar-nav');
        if (!navMenu) return;

        // Avoid multiple rails
        if (sidebar.querySelector('.sidebar-scroll-rail')) return;

        // Create the scroll rail
        const rail = document.createElement('div');
        rail.className = 'sidebar-scroll-rail';
        rail.id = 'sidebarScrollRail';
        rail.setAttribute('aria-hidden', 'true');
        rail.innerHTML = `
            <button type="button" class="sidebar-scroll-btn scroll-up" id="sidebarScrollUp" title="Scroll up" aria-label="Scroll menu up" tabindex="-1">
                <svg width="9" height="7" viewBox="0 0 10 7" fill="currentColor"><path d="M5 0L10 6.5H0L5 0Z"/></svg>
            </button>
            <div class="sidebar-scroll-track" id="sidebarScrollTrack" title="Scroll track">
                <div class="sidebar-scroll-thumb" id="sidebarScrollThumb" title="Drag to scroll"></div>
            </div>
            <button type="button" class="sidebar-scroll-btn scroll-down" id="sidebarScrollDown" title="Scroll down" aria-label="Scroll menu down" tabindex="-1">
                <svg width="9" height="7" viewBox="0 0 10 7" fill="currentColor"><path d="M5 7L0 0.5H10L5 7Z"/></svg>
            </button>
        `;

        sidebar.appendChild(rail);

        const btnUp = rail.querySelector('#sidebarScrollUp');
        const btnDown = rail.querySelector('#sidebarScrollDown');
        const track = rail.querySelector('#sidebarScrollTrack');
        const thumb = rail.querySelector('#sidebarScrollThumb');

        let isDragging = false;
        let startY = 0;
        let startScrollTop = 0;

        function syncRail() {
            if (!navMenu || !sidebar) return;
            const navRect = navMenu.getBoundingClientRect();
            const sidebarRect = sidebar.getBoundingClientRect();
            
            // Align rail precisely with navMenu bounds
            const topOffset = navRect.top - sidebarRect.top;
            const height = navRect.height;

            rail.style.top = `${topOffset}px`;
            rail.style.height = `${height}px`;

            const scrollable = navMenu.scrollHeight > navMenu.clientHeight + 4;
            if (!scrollable) {
                rail.style.display = 'none';
                return;
            }

            rail.style.display = 'flex';

            const trackHeight = track.clientHeight;
            if (trackHeight <= 0) return;

            const scrollRatio = navMenu.clientHeight / navMenu.scrollHeight;
            const thumbHeight = Math.max(36, Math.min(trackHeight - 10, trackHeight * scrollRatio));
            thumb.style.height = `${thumbHeight}px`;

            const maxScrollTop = navMenu.scrollHeight - navMenu.clientHeight;
            const scrollProgress = maxScrollTop > 0 ? (navMenu.scrollTop / maxScrollTop) : 0;
            const maxTravel = trackHeight - thumbHeight;
            const thumbY = scrollProgress * maxTravel;

            thumb.style.transform = `translateY(${thumbY}px)`;

            // Visual feedback on arrow buttons
            if (navMenu.scrollTop <= 2) {
                btnUp.classList.add('at-limit');
            } else {
                btnUp.classList.remove('at-limit');
            }

            if (navMenu.scrollTop >= maxScrollTop - 2) {
                btnDown.classList.add('at-limit');
            } else {
                btnDown.classList.remove('at-limit');
            }
        }

        // Sync on scroll
        navMenu.addEventListener('scroll', syncRail, { passive: true });

        // Scroll Buttons
        btnUp.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            navMenu.scrollBy({ top: -140, behavior: 'smooth' });
        });

        btnDown.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            navMenu.scrollBy({ top: 140, behavior: 'smooth' });
        });

        // Track Click
        track.addEventListener('click', (e) => {
            if (e.target === thumb) return;
            const trackRect = track.getBoundingClientRect();
            const clickY = e.clientY - trackRect.top;
            const trackHeight = trackRect.height;
            const thumbHeight = thumb.clientHeight;
            const targetRatio = Math.max(0, Math.min(1, (clickY - thumbHeight / 2) / (trackHeight - thumbHeight)));
            const maxScrollTop = navMenu.scrollHeight - navMenu.clientHeight;
            navMenu.scrollTo({ top: targetRatio * maxScrollTop, behavior: 'smooth' });
        });

        // Thumb Drag
        thumb.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = true;
            startY = e.clientY;
            startScrollTop = navMenu.scrollTop;
            thumb.classList.add('dragging');
            document.body.style.userSelect = 'none';

            function onMouseMove(ev) {
                if (!isDragging) return;
                const deltaY = ev.clientY - startY;
                const trackHeight = track.clientHeight;
                const thumbHeight = thumb.clientHeight;
                const maxTravel = trackHeight - thumbHeight;
                if (maxTravel <= 0) return;
                const maxScrollTop = navMenu.scrollHeight - navMenu.clientHeight;
                navMenu.scrollTop = startScrollTop + (deltaY / maxTravel) * maxScrollTop;
            }

            function onMouseUp() {
                isDragging = false;
                thumb.classList.remove('dragging');
                document.body.style.userSelect = '';
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
            }

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });

        // Observers and intervals for dynamic content
        window.addEventListener('resize', syncRail);

        if (window.ResizeObserver) {
            const ro = new ResizeObserver(syncRail);
            ro.observe(navMenu);
            ro.observe(sidebar);
        }

        // Initial updates
        syncRail();
        setTimeout(syncRail, 200);
        setTimeout(syncRail, 600);
        setTimeout(syncRail, 1500);
        setTimeout(syncRail, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSidebarScrollbar);
    } else {
        initSidebarScrollbar();
    }
})();
