/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - ESS POLICY VIEWER & DIGITAL SIGNATURE MODAL
 * ============================================================================
 * Conforms to PRD Sections 13 & 17:
 * - Embedded PDF Viewer with interactive reading panel
 * - Mandatory Scroll-to-Bottom verification gate before unlocking "I Agree and Acknowledge"
 * - Tamper-resistant digital signature capture:
 *   { policyCode, version, employeeId, acknowledgedAt, ipAddress, userAgent }
 * - Persisted under organizations/{orgId}/policy_acknowledgements/{employeeId}_{policyCode}_{version}
 * ============================================================================
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['./companyPolicyService'], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./companyPolicyService'));
    } else {
        root.KylrxPolicyViewerModal = factory(root.KylrxCompanyPolicyService || root.companyPolicyService);
        root.companyPolicyViewerModal = root.KylrxPolicyViewerModal;
    }
}(typeof self !== 'undefined' ? self : this, function (policyService) {
    'use strict';

    let currentPolicy = null;
    let currentEmployee = null;
    let onAcknowledgedCallback = null;
    let hasScrolledToBottom = false;

    function escapeHtml(str) {
        if (!str && str !== 0) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Default policy dummy bodies if document URL is not loaded or for offline preview
    const DEFAULT_POLICY_TEXTS = {
        POL_POSH_01: `
            <h3>1. Purpose & Organizational Commitment</h3>
            <p>Kylrx Technologies is strictly committed to providing a safe, respectful, and dignified work environment free from sexual harassment, discrimination, and intimidation for all employees, interns, contract workers, and visitors.</p>
            <h3>2. Legislative Framework & Internal Complaints Committee (ICC)</h3>
            <p>In strict compliance with the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013, an autonomous Internal Complaints Committee (ICC) has been constituted with majority women members and external NGO representation.</p>
            <h3>3. Zero-Tolerance & Retaliation Protection</h3>
            <p>Any act of workplace harassment or reprisal against a complainant or witness will result in immediate disciplinary action up to summary termination of employment and criminal reporting.</p>
            <h3>4. Grievance Redressal Process</h3>
            <p>Formal complaints may be submitted in confidence to icc@kylrx.ai within 90 days of an incident. Inquiries are finalized within statutory limits (90 days) with strict confidentiality protocols.</p>
        `,
        POL_COC_01: `
            <h3>1. Core Principles</h3>
            <p>Every member of the Onn HR workforce must uphold the highest standards of integrity, transparency, professional objectivity, and regulatory compliance in all corporate dealings.</p>
            <h3>2. Conflicts of Interest & Gifts</h3>
            <p>Employees must avoid any personal or financial conflict of interest. Soliciting or accepting personal kickbacks, gifts, or inducements from vendors, clients, or partners is strictly prohibited.</p>
            <h3>3. Protection of Enterprise IP & Assets</h3>
            <p>All source code, AI models, client datasets, patents, and proprietary systems created during employment remain the sole intellectual property of Kylrx Technologies Pvt. Ltd.</p>
        `,
        POL_IT_SEC_01: `
            <h3>1. Information Security & Access Controls</h3>
            <p>Mandatory Multi-Factor Authentication (MFA) must be enabled on all corporate email, GitHub, AWS, and Cloud Firestore accounts. Passwords must never be shared or hardcoded.</p>
            <h3>2. Device Security & Clean Desk Policy</h3>
            <p>Workstation screens must be locked when unattended. Storage of unencrypted customer Personally Identifiable Information (PII) on personal devices is a severe breach.</p>
            <h3>3. Incident Reporting</h3>
            <p>Any suspected data breach, phishing attempt, or hardware loss must be reported immediately to security@kylrx.ai within 1 hour of discovery.</p>
        `
    };

    /**
     * Injects Modal CSS into Document Head
     */
    function injectModalStyles() {
        if (typeof document === 'undefined' || document.getElementById('kylrx-policy-modal-styles')) return;

        const style = document.createElement('style');
        style.id = 'kylrx-policy-modal-styles';
        style.textContent = `
            .kpm-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(15, 23, 42, 0.7);
                backdrop-filter: blur(8px);
                z-index: 10000;
                display: none;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: opacity 0.25s ease-out;
            }
            .kpm-overlay.active {
                display: flex;
                opacity: 1;
            }
            .kpm-modal {
                background: #ffffff;
                width: 92%;
                max-width: 820px;
                height: 88vh;
                max-height: 860px;
                border-radius: 24px;
                box-shadow: 0 25px 50px -12px rgba(15, 23, 42, 0.35);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                border: 1px solid #e2e8f0;
                animation: kpmSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            }
            @keyframes kpmSlideUp {
                from { transform: translateY(24px) scale(0.98); opacity: 0; }
                to { transform: translateY(0) scale(1); opacity: 1; }
            }
            .kpm-header {
                padding: 1.5rem 2rem;
                background: #f8fafc;
                border-bottom: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-shrink: 0;
            }
            .kpm-header-left {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .kpm-badges {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .kpm-badge {
                font-size: 0.7rem;
                font-weight: 800;
                padding: 3px 8px;
                border-radius: 6px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            .kpm-badge-statutory { background: #fee2e2; color: #991b1b; }
            .kpm-badge-operational { background: #e0e7ff; color: #3730a3; }
            .kpm-badge-conduct { background: #fef3c7; color: #92400e; }
            .kpm-badge-security { background: #dcfce7; color: #166534; }
            .kpm-badge-version { background: #f1f5f9; color: #475569; }
            .kpm-title {
                font-size: 1.35rem;
                font-weight: 800;
                color: #0f172a;
                margin: 0;
            }
            .kpm-meta {
                font-size: 0.8rem;
                color: #64748b;
                display: flex;
                gap: 16px;
                align-items: center;
            }
            .kpm-close-btn {
                background: none;
                border: none;
                color: #94a3b8;
                cursor: pointer;
                padding: 6px;
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s ease;
            }
            .kpm-close-btn:hover {
                background: #e2e8f0;
                color: #0f172a;
            }
            .kpm-body {
                flex: 1;
                overflow-y: auto;
                padding: 2rem;
                background: #ffffff;
                line-height: 1.7;
                color: #334155;
                font-size: 0.95rem;
                border-bottom: 1px solid #e2e8f0;
            }
            .kpm-body h3 {
                font-size: 1.15rem;
                font-weight: 800;
                color: #0f172a;
                margin: 1.5rem 0 0.5rem 0;
            }
            .kpm-body h3:first-child {
                margin-top: 0;
            }
            .kpm-body p {
                margin-bottom: 1rem;
            }
            .kpm-body iframe {
                width: 100%;
                height: 520px;
                border: 1px solid #cbd5e1;
                border-radius: 12px;
                margin-bottom: 1rem;
            }
            .kpm-scroll-indicator {
                background: #eff6ff;
                border: 1px dashed #3b82f6;
                color: #1d4ed8;
                padding: 10px 16px;
                border-radius: 12px;
                font-size: 0.85rem;
                font-weight: 700;
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-top: 1rem;
            }
            .kpm-footer {
                padding: 1.25rem 2rem;
                background: #f8fafc;
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-shrink: 0;
                gap: 16px;
            }
            .kpm-footer-audit {
                font-size: 0.75rem;
                color: #64748b;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .kpm-sign-btn {
                padding: 12px 24px;
                border-radius: 12px;
                font-weight: 700;
                font-size: 0.95rem;
                border: none;
                cursor: pointer;
                transition: all 0.2s ease;
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }
            .kpm-sign-btn:not(:disabled) {
                background: #2563eb;
                color: #ffffff;
                box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.3);
            }
            .kpm-sign-btn:not(:disabled):hover {
                background: #1d4ed8;
                transform: translateY(-1px);
            }
            .kpm-sign-btn:disabled {
                background: #cbd5e1;
                color: #64748b;
                cursor: not-allowed;
                opacity: 0.7;
            }
            .kpm-sign-btn.signed {
                background: #10b981 !important;
                color: white !important;
                cursor: default;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Build and inject the Modal DOM elements if not already present
     */
    function ensureModalDom() {
        if (typeof document === 'undefined') return;
        injectModalStyles();

        let overlay = document.getElementById('kylrxPolicyModalOverlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'kylrxPolicyModalOverlay';
        overlay.className = 'kpm-overlay';
        overlay.innerHTML = `
            <div class="kpm-modal" role="dialog" aria-modal="true">
                <div class="kpm-header">
                    <div class="kpm-header-left">
                        <div class="kpm-badges" id="kpmBadges"></div>
                        <h2 class="kpm-title" id="kpmPolicyTitle">Policy Title</h2>
                        <div class="kpm-meta" id="kpmMetaInfo"></div>
                    </div>
                    <button class="kpm-close-btn" id="kpmCloseBtn" title="Close Viewer">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
                <div class="kpm-body" id="kpmBody">
                    <div id="kpmContentContainer"></div>
                    <div class="kpm-scroll-indicator" id="kpmScrollIndicator">
                        <span>📜 Scroll to the bottom of the policy text to unlock agreement</span>
                        <span id="kpmScrollPct">0%</span>
                    </div>
                </div>
                <div class="kpm-footer">
                    <div class="kpm-footer-audit" id="kpmAuditMeta">
                        <span>Digital Signature Audit Log: Enabled</span>
                        <span id="kpmAuditDetails">Capturing Client Timestamp & IP Verification</span>
                    </div>
                    <button class="kpm-sign-btn" id="kpmSignBtn" disabled>
                        <span>🔒 I Agree and Acknowledge</span>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Bind Close handlers
        const closeBtn = document.getElementById('kpmCloseBtn');
        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        // Bind Scroll Detection
        const bodyEl = document.getElementById('kpmBody');
        bodyEl.addEventListener('scroll', handleBodyScroll);

        // Bind Acknowledgment Click
        const signBtn = document.getElementById('kpmSignBtn');
        signBtn.addEventListener('click', handleSignClick);

        return overlay;
    }

    /**
     * Scroll event listener enforcing mandatory reading to bottom
     */
    function handleBodyScroll() {
        const bodyEl = document.getElementById('kpmBody');
        if (!bodyEl) return;

        const scrollTop = bodyEl.scrollTop;
        const scrollHeight = bodyEl.scrollHeight;
        const clientHeight = bodyEl.clientHeight;

        const maxScroll = scrollHeight - clientHeight;
        const scrollPct = maxScroll > 0 ? Math.min(100, Math.round((scrollTop / maxScroll) * 100)) : 100;

        const pctEl = document.getElementById('kpmScrollPct');
        if (pctEl) pctEl.textContent = `${scrollPct}%`;

        // Check if reached bottom (tolerance 15px)
        if (maxScroll <= 10 || (scrollHeight - scrollTop <= clientHeight + 15)) {
            if (!hasScrolledToBottom) {
                hasScrolledToBottom = true;
                unlockSignButton();
            }
        }
    }

    /**
     * Unlocks the Digital Signature Button
     */
    function unlockSignButton() {
        const signBtn = document.getElementById('kpmSignBtn');
        const scrollIndicator = document.getElementById('kpmScrollIndicator');

        if (signBtn && !signBtn.classList.contains('signed')) {
            signBtn.disabled = false;
            signBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>I Agree and Acknowledge</span>
            `;
        }

        if (scrollIndicator) {
            scrollIndicator.style.background = '#ecfdf5';
            scrollIndicator.style.borderColor = '#10b981';
            scrollIndicator.style.color = '#047857';
            scrollIndicator.innerHTML = `
                <span>✅ Document read in full. You are authorized to digitally sign.</span>
                <span>100%</span>
            `;
        }
    }

    /**
     * Resolve the real client IP address via ipify (non-blocking, best-effort)
     * Falls back to '127.0.0.1' on any network failure so the sign-off is never blocked.
     */
    async function resolveClientIp() {
        try {
            const res = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
                const json = await res.json();
                return json.ip || '127.0.0.1';
            }
        } catch (_) {
            // Network blocked or offline – fall back gracefully
        }
        return '127.0.0.1';
    }

    /**
     * Compute a lightweight SHA-256 tamper-check hash for the audit record.
     * Combines: policyCode + '|' + version + '|' + employeeId + '|' + acknowledgedAt
     * Returns hex string (null in environments where SubtleCrypto is unavailable).
     */
    async function computeAuditHash(policyCode, version, employeeId, acknowledgedAt) {
        try {
            if (typeof crypto === 'undefined' || !crypto.subtle) return null;
            const message = `${policyCode}|${version}|${employeeId}|${acknowledgedAt}`;
            const msgBuffer = new TextEncoder().encode(message);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
            return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        } catch (_) {
            return null;
        }
    }

    /**
     * Handle Sign-off Button Click
     */
    async function handleSignClick() {
        if (!currentPolicy || !currentEmployee) return;

        const signBtn = document.getElementById('kpmSignBtn');
        signBtn.disabled = true;
        signBtn.innerHTML = `<span>Saving signature...</span>`;

        try {
            const orgId = currentEmployee.orgId || 'org_kylrx_default';
            const policyCode = currentPolicy.policyCode || currentPolicy.Policy_Code;
            const version = currentPolicy.version || currentPolicy.Version || '1.0';
            const employeeId = currentEmployee.employeeId || currentEmployee.id;
            const acknowledgedAt = new Date().toISOString();

            // ── Step 1: Resolve real client IP (non-blocking, best-effort)
            const ipAddress = await resolveClientIp();

            // ── Step 2: Compute tamper-evident audit hash
            const auditHash = await computeAuditHash(policyCode, version, employeeId, acknowledgedAt);

            const res = await (policyService || root.KylrxCompanyPolicyService).recordDigitalAcknowledgement({
                policyCode,
                version,
                employeeId,
                employeeName: currentEmployee.employeeName || currentEmployee.name,
                ipAddress,
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Kylrx-ESS-Client',
                acknowledgedAt,
                auditIntegrityHash: auditHash
            }, orgId);

            signBtn.classList.add('signed');
            signBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                <span>Signed &amp; Verified ✓</span>
            `;

            const auditDetails = document.getElementById('kpmAuditDetails');
            if (auditDetails) {
                const hashPreview = auditHash ? auditHash.substring(0, 12) + '…' : 'N/A';
                auditDetails.textContent = `Signed on ${new Date(acknowledgedAt).toLocaleString()} (Ref: ${res.ackDocId} | Hash: ${hashPreview})`;
                auditDetails.style.color = '#15803d';
                auditDetails.style.fontWeight = '700';
            }

            // Dispatch global event for other components
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('policy-acknowledged', {
                    detail: { policyCode, version, employeeId, ackDocId: res.ackDocId, auditHash }
                }));
            }

            if (typeof onAcknowledgedCallback === 'function') {
                onAcknowledgedCallback(res);
            }
        } catch (err) {
            console.error('[POLICY_MODAL] Digital signature error:', err);
            signBtn.disabled = false;
            signBtn.innerHTML = `<span>Retry Sign-off</span>`;
            alert('Failed to record digital acknowledgement: ' + err.message);
        }
    }

    /**
     * Open Policy Viewer Modal
     */
    function openPolicyModal(policy, employee, options = {}) {
        ensureModalDom();
        currentPolicy = policy;
        currentEmployee = employee;
        onAcknowledgedCallback = options.onAcknowledged || null;
        hasScrolledToBottom = false;

        const overlay = document.getElementById('kylrxPolicyModalOverlay');
        const titleEl = document.getElementById('kpmPolicyTitle');
        const badgesEl = document.getElementById('kpmBadges');
        const metaEl = document.getElementById('kpmMetaInfo');
        const contentContainer = document.getElementById('kpmContentContainer');
        const signBtn = document.getElementById('kpmSignBtn');
        const auditDetails = document.getElementById('kpmAuditDetails');
        const scrollIndicator = document.getElementById('kpmScrollIndicator');
        const bodyEl = document.getElementById('kpmBody');

        const pCode = policy.policyCode || policy.Policy_Code || 'POL_01';
        const pName = policy.policyName || policy.Policy_Name || 'Company Policy';
        const version = policy.version || policy.Version || '1.0';
        const pType = policy.policyType || policy.Policy_Type || 'Operational';
        const docUrl = policy.documentUrl || policy.Document_URL_or_File_Name || '';
        const dueDays = policy.acknowledgementDueDays || policy.Acknowledgement_Due_Days || 14;

        titleEl.textContent = pName;

        // Render Badges
        const typeClass = pType === 'Statutory' ? 'kpm-badge-statutory'
            : pType === 'Code_of_Conduct' ? 'kpm-badge-conduct'
            : pType === 'IT_Security' ? 'kpm-badge-security'
            : 'kpm-badge-operational';

        badgesEl.innerHTML = `
            <span class="kpm-badge ${typeClass}">${escapeHtml(pType)}</span>
            <span class="kpm-badge kpm-badge-version">v${escapeHtml(version)}</span>
            <span class="kpm-badge" style="background:#e0f2fe; color:#0369a1;">Code: ${escapeHtml(pCode)}</span>
        `;

        metaEl.innerHTML = `
            <span>Effective: ${escapeHtml(policy.effectiveFrom || policy.Effective_From || '2026-01-01')}</span>
            <span>•</span>
            <span>Turnaround SLA: ${escapeHtml(dueDays)} Days</span>
        `;

        // Check if already acknowledged
        const isAcknowledged = options.isAcknowledged || Boolean(options.acknowledgement);

        // Inject Content / PDF
        let bodyHtml = '';
        if (docUrl && (docUrl.endsWith('.pdf') || docUrl.includes('storage.googleapis') || docUrl.startsWith('http'))) {
            bodyHtml += `<iframe src="${escapeHtml(docUrl)}#toolbar=0" title="${escapeHtml(pName)}"></iframe>`;
        }

        // Add rich fallback content text
        const fallbackText = DEFAULT_POLICY_TEXTS[pCode] || `
            <h3>1. Scope and Applicability</h3>
            <p>This policy applies to all personnel designated under category <strong>${escapeHtml(policy.appliesToCategoryCode || 'ALL')}</strong> at location <strong>${escapeHtml(policy.appliesToLocationCode || 'ALL')}</strong>.</p>
            <h3>2. Key Obligations and Governance</h3>
            <p>Employees must adhere to all statutory and organizational guidelines articulated herein. Failure to comply with enterprise policies constitutes a breach of the employee code of conduct and may result in disciplinary action up to termination.</p>
            <h3>3. Inquiries & HR Support</h3>
            <p>For inquiries, clarification, or incident reporting, contact the People Operations and Compliance desk at compliance@kylrx.ai.</p>
        `;
        bodyHtml += fallbackText;
        contentContainer.innerHTML = bodyHtml;

        // Reset scroll position and state
        bodyEl.scrollTop = 0;

        if (isAcknowledged) {
            signBtn.disabled = true;
            signBtn.classList.add('signed');
            signBtn.innerHTML = `<span>Signed & Verified ✓</span>`;
            if (scrollIndicator) scrollIndicator.style.display = 'none';
            if (auditDetails) {
                const ackDate = options.acknowledgement && options.acknowledgement.acknowledgedAt ? new Date(options.acknowledgement.acknowledgedAt).toLocaleString() : 'Already Verified';
                auditDetails.textContent = `Acknowledged on ${ackDate}`;
                auditDetails.style.color = '#15803d';
            }
        } else {
            signBtn.classList.remove('signed');
            signBtn.disabled = true;
            signBtn.innerHTML = `<span>🔒 I Agree and Acknowledge</span>`;
            if (scrollIndicator) {
                scrollIndicator.style.display = 'flex';
                scrollIndicator.style.background = '#eff6ff';
                scrollIndicator.style.borderColor = '#3b82f6';
                scrollIndicator.style.color = '#1d4ed8';
                scrollIndicator.innerHTML = `
                    <span>📜 Scroll to the bottom of the policy text to unlock agreement</span>
                    <span id="kpmScrollPct">0%</span>
                `;
            }
            if (auditDetails) {
                auditDetails.textContent = `Pending Digital Signature for Employee ${employee.employeeId || employee.id}`;
                auditDetails.style.color = '#64748b';
            }
        }

        overlay.classList.add('active');

        // Check if content fits completely on screen without scrolling
        setTimeout(() => {
            if (bodyEl.scrollHeight <= bodyEl.clientHeight + 20 && !isAcknowledged) {
                unlockSignButton();
            }
        }, 150);
    }

    /**
     * Close Policy Viewer Modal
     */
    function closeModal() {
        const overlay = document.getElementById('kylrxPolicyModalOverlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    return {
        openPolicyModal,
        closeModal,
        unlockSignButton,
        ensureModalDom
    };
}));
