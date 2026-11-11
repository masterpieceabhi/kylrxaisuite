import { db, auth, onAuthStateChanged, doc, getDoc, collection, query, where, getDocs } from "./firebase-config.js";
import './country-gate.js';

/**
 * HRMS Suite Sidebar & Profile Synchronization
 * Displays HRMS Manager and Strategic Operations across all HRMS pages
 * with clean typography and zero text truncation.
 */
export function initHrmsSidebar() {
    function updateHrmsUI(name, role) {
        let finalName = name || localStorage.getItem('hrms_manager_name') || 'Savitha Balraju';
        if (finalName === 'HRMS Manager' || finalName === 'Savitha' || finalName.toLowerCase().startsWith('employee') || finalName.toLowerCase() === 'marry doe') {
            finalName = 'Savitha Balraju';
        }
        if (finalName.includes('@')) {
            const prefix = finalName.split('@')[0];
            finalName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
        }

        let finalRole = role || localStorage.getItem('hrms_manager_role') || 'Strategic Operations';
        const lower = String(finalRole).toLowerCase();
        if (lower === 'hrms' || lower === 'hr_admin' || lower === 'admin') {
            finalRole = 'Strategic Operations';
        }

        const parts = finalName.trim().split(/[\s._-]+/).filter(Boolean);
        const initials = finalName === 'Savitha Balraju' ? 'SB' : (parts.length > 1 
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() 
            : (parts[0] ? parts[0].slice(0, 2).toUpperCase() : 'SB'));

        const elements = {
            userInitial: initials,
            sideUserInitial: initials,
            topUserAvatar: initials,
            userNameDisplay: finalName,
            sideUserName: finalName,
            topUserName: finalName,
            userRoleDisplay: finalRole,
            sideUserRole: finalRole,
            topUserRole: finalRole,
            welcomeUserName: finalName
        };

        Object.entries(elements).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        });

        document.querySelectorAll('.user-name').forEach(el => el.textContent = finalName);
        document.querySelectorAll('.user-role').forEach(el => el.textContent = finalRole);

        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
        }
    }


    window.updateHrmsProfileUI = updateHrmsUI;

    window.logout = async () => {
        try {
            if (auth && auth.signOut) await auth.signOut();
        } catch (e) {
            console.warn("Logout error:", e);
        }
        localStorage.clear();
        window.location.href = 'index.html';
    };

    // Immediate pre-render to guarantee Savitha Balraju and Strategic Operations
    updateHrmsUI('Savitha Balraju', 'Strategic Operations');
}

// Auto-run when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHrmsSidebar);
} else {
    initHrmsSidebar();
}
