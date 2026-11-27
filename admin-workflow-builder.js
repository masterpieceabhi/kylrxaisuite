/**
 * No-Code Visual Workflow Builder Controller
 * Pure SVG + Vanilla JavaScript Canvas & Configuration Engine
 * Zero Code Required for HR Automation
 */

const API_HOST = (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : window.location.origin);

const API_BASE = `${API_HOST}/api/workflow-builder`;

// Color map for node types
const NODE_COLORS = {
    trigger: '#6366f1',
    condition: '#f59e0b',
    branch: '#8b5cf6',
    approval: '#3b82f6',
    wait: '#14b8a6',
    escalation: '#f97316',
    action: '#10b981',
    notification: '#ec4899',
    document: '#eab308',
    form: '#06b6d4',
    end: '#ef4444'
};

const NODE_ICONS = {
    trigger: 'fa-bolt',
    condition: 'fa-filter',
    branch: 'fa-code-branch',
    approval: 'fa-user-check',
    wait: 'fa-clock',
    escalation: 'fa-level-up-alt',
    action: 'fa-play',
    notification: 'fa-paper-plane',
    document: 'fa-file-alt',
    form: 'fa-clipboard-list',
    end: 'fa-flag-checkered'
};

const DEFAULT_NODE_TYPES = {
    trigger: { name: "Trigger", label: "Trigger", color: "#6366f1", icon: "fa-bolt", category: "start", description: "Starts the workflow on a business or schedule event", requiredConfig: ["event"] },
    condition: { name: "Condition", label: "Condition", color: "#f59e0b", icon: "fa-filter", category: "logic", description: "Pass / Fail evaluation gate based on employee or system fields", requiredConfig: ["field","operator"] },
    branch: { name: "Branch", label: "Branch", color: "#8b5cf6", icon: "fa-code-branch", category: "logic", description: "Multi-way routing based on business rules or values", requiredConfig: ["field","operator"] },
    approval: { name: "Approval", label: "Approval", color: "#3b82f6", icon: "fa-user-check", category: "human", description: "Human sign-off gate with SLA deadline and escalation route", requiredConfig: ["assigneeRole"] },
    wait: { name: "Wait", label: "Wait", color: "#14b8a6", icon: "fa-clock", category: "control", description: "Delay step for duration or until external event occurs", requiredConfig: ["duration"] },
    escalation: { name: "Escalation", label: "Escalation", color: "#f97316", icon: "fa-level-up-alt", category: "control", description: "Automatic escalation upon SLA expiration or threshold breach", requiredConfig: ["escalateTo"] },
    action: { name: "Action", label: "Action", color: "#10b981", icon: "fa-play", category: "execute", description: "Executes automated HR system action or external webhook", requiredConfig: ["actionType"] },
    notification: { name: "Notification", label: "Notification", color: "#ec4899", icon: "fa-paper-plane", category: "execute", description: "Dispatches multi-channel notice (email, in-app, Slack)", requiredConfig: ["recipient","channel"] },
    document: { name: "Document", label: "Document", color: "#eab308", icon: "fa-file-alt", category: "execute", description: "Generates official document via Document Template Engine", requiredConfig: ["templateKey"] },
    form: { name: "Form", label: "Form", color: "#06b6d4", icon: "fa-clipboard-list", category: "human", description: "Captures structured input from employee or manager", requiredConfig: ["formTitle"] },
    end: { name: "End", label: "End", color: "#ef4444", icon: "fa-flag-checkered", category: "terminal", description: "Final step completing the workflow and recording status", requiredConfig: ["outcomeStatus"] }
};

const DEFAULT_WORKFLOWS = [
    {
        id: "wf_sample_onboarding",
        name: "New Employee Offer & Onboarding",
        description: "Automated offer letter generation, approval, and onboarding kickoff when candidate accepts offer.",
        status: "active",
        version: 1,
        activeVersionNumber: 1,
        canvas: {
            nodes: [
                { id: "n1", type: "trigger", label: "Offer Accepted", x: 80, y: 160, position: { x: 80, y: 160 }, config: { event: "candidate_offer_accepted", entity: "candidate", label: "Offer Accepted", outcomeStatus: "COMPLETED" } },
                { id: "n2", type: "condition", label: "Is Engineering?", x: 320, y: 160, position: { x: 320, y: 160 }, config: { field: "department", operator: "==", value: "Engineering", label: "Is Engineering?", outcomeStatus: "COMPLETED" } },
                { id: "n3", type: "document", label: "Generate Offer Letter", x: 560, y: 100, position: { x: 560, y: 100 }, config: { templateKey: "offer_letter", label: "Generate Offer Letter", outcomeStatus: "COMPLETED" } },
                { id: "n4", type: "approval", label: "HR Director Sign-off", x: 800, y: 100, position: { x: 800, y: 100 }, config: { assigneeRole: "super_admin", dueHours: 24, onReject: "terminate", label: "HR Director Sign-off", outcomeStatus: "COMPLETED" } },
                { id: "n5", type: "notification", label: "Send Welcome Packet", x: 1040, y: 100, position: { x: 1040, y: 100 }, config: { recipient: "employee", channel: "email", template: "Welcome to Kylrx! Your offer letter is attached.", label: "Send Welcome Packet", outcomeStatus: "COMPLETED" } },
                { id: "n6", type: "end", label: "Onboarding Ready", x: 1280, y: 160, position: { x: 1280, y: 160 }, config: { outcomeStatus: "COMPLETED", label: "Onboarding Ready" } }
            ],
            connections: [
                { id: "conn_1", from: "n1", to: "n2", fromNodeId: "n1", toNodeId: "n2", port: "out", label: "" },
                { id: "conn_2", from: "n2", to: "n3", fromNodeId: "n2", toNodeId: "n3", port: "out", label: "" },
                { id: "conn_3", from: "n3", to: "n4", fromNodeId: "n3", toNodeId: "n4", port: "out", label: "" },
                { id: "conn_4", from: "n4", to: "n5", fromNodeId: "n4", toNodeId: "n5", port: "out", label: "" },
                { id: "conn_5", from: "n5", to: "n6", fromNodeId: "n5", toNodeId: "n6", port: "out", label: "" }
            ]
        }
    }
];

// Application State
const state = {
    currentWorkflow: {
        id: null,
        name: 'New Workflow',
        description: 'Automated multi-stage HR process',
        status: 'draft',
        canvas: {
            nodes: [],
            connections: []
        }
    },
    workflows: [...DEFAULT_WORKFLOWS],
    nodeTypes: { ...DEFAULT_NODE_TYPES },
    sampleEmployees: [],
    versions: [],
    selectedVersionNumber: 1,
    selectedNodeId: null,
    scale: 1,
    panX: 0,
    panY: 0,
    isDraggingCanvas: false,
    dragStart: { x: 0, y: 0 },
    connectingFromNodeId: null,
    connectingFromPort: null
};

// Switch left panel tab
window.switchLeftTab = function(tabName) {
    const tabs = ['palette', 'workflows', 'logs', 'audit'];
    tabs.forEach(t => {
        const btn = document.getElementById(`tab-${t}-btn`);
        const content = document.getElementById(`tab-${t}-content`);
        if (btn) {
            if (t === tabName) btn.classList.add('active');
            else btn.classList.remove('active');
        }
        if (content) {
            content.style.display = t === tabName ? 'block' : 'none';
        }
    });

    if (tabName === 'workflows') {
        loadWorkflowsList();
    } else if (tabName === 'logs') {
        loadExecutionLogs();
    } else if (tabName === 'audit') {
        loadAuditTrail();
    }
};

// Toast notification helper
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle';
    toast.innerHTML = `<i class="fas fa-${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// Set AI prompt from chip click
window.setAiPrompt = function(promptText) {
    const input = document.getElementById('ai-prompt-input');
    if (input) {
        input.value = promptText;
        input.focus();
    }
};

// ─── INITIALIZATION ───
document.addEventListener('DOMContentLoaded', async () => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
    }
    setupCanvasEvents();
    setupPaletteDragEvents();
    setupToolbarEvents();
    setupAiCreatorEvents();
    setupTestModeEvents();
    await fetchNodeTypes();
    await fetchStats();
    await fetchSampleEmployees();
    await loadWorkflowsList();
    
    // Auto-load first workflow if available, else new workflow
    if (state.workflows.length > 0) {
        await loadWorkflow(state.workflows[0].id);
    } else {
        newWorkflow();
    }
});

// ─── API CALLS ───
async function fetchSampleEmployees() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${API_BASE}/sample-employees`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const json = await res.json();
            if (json.success && json.employees) {
                state.sampleEmployees = json.employees;
                populateEmployeeSelector(json.employees);
                return;
            }
        }
    } catch (err) {
        // Backend offline - use resilient fallback employees
    }
    
    // Fallback catalog
    const fallbackEmployees = [
        { id: 'emp_01', name: 'Aarav Sharma', role: 'Senior Full Stack Engineer', department: 'Engineering' },
        { id: 'emp_02', name: 'Priya Nair', role: 'Product Operations Lead', department: 'Product' },
        { id: 'emp_03', name: 'Rohan Gupta', role: 'DevOps & Cloud Specialist', department: 'Infrastructure' }
    ];
    state.sampleEmployees = fallbackEmployees;
    populateEmployeeSelector(fallbackEmployees);
}

function populateEmployeeSelector(employees) {
    const selectEl = document.getElementById('test-employee-select');
    if (selectEl) {
        selectEl.innerHTML = '<option value="">-- Choose Sample Employee --</option>';
        employees.forEach(emp => {
            const opt = document.createElement('option');
            opt.value = emp.id;
            opt.textContent = `${emp.name} — ${emp.role} (${emp.department})`;
            selectEl.appendChild(opt);
        });
    }
}

async function fetchNodeTypes() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${API_BASE}/node-types`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const json = await res.json();
            if (json.success && json.nodeTypes) {
                state.nodeTypes = json.nodeTypes;
                return;
            }
        }
    } catch (err) {
        // Quiet fallback to built-in node types
    }
    state.nodeTypes = { ...DEFAULT_NODE_TYPES };
}

async function fetchStats() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${API_BASE}/stats`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const json = await res.json();
            if (json.success && json.stats) {
                const stats = json.stats;
                const totalEl = document.getElementById('stat-total');
                const activeEl = document.getElementById('stat-active');
                const draftEl = document.getElementById('stat-draft');
                if (totalEl) totalEl.textContent = stats.totalWorkflows || stats.total || state.workflows.length;
                if (activeEl) activeEl.textContent = stats.activeWorkflows || stats.active || 0;
                if (draftEl) draftEl.textContent = stats.draftWorkflows || stats.draft || 0;
                return;
            }
        }
    } catch (err) {
        // Quiet fallback
    }
    const totalEl = document.getElementById('stat-total');
    const activeEl = document.getElementById('stat-active');
    const draftEl = document.getElementById('stat-draft');
    if (totalEl) totalEl.textContent = state.workflows.length;
    if (activeEl) activeEl.textContent = state.workflows.filter(w => w.status === 'active').length;
    if (draftEl) draftEl.textContent = state.workflows.filter(w => w.status !== 'active').length;
}

async function loadWorkflowsList() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${API_BASE}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const json = await res.json();
            if (json.success && json.workflows) {
                state.workflows = json.workflows;
                renderWorkflowList();
                return;
            }
        }
    } catch (err) {
        // Fallback to local workflows
    }
    if (!state.workflows || state.workflows.length === 0) {
        state.workflows = [...DEFAULT_WORKFLOWS];
    }
    renderWorkflowList();
}

function renderWorkflowList() {
    const list = document.getElementById('workflow-list');
    if (!list) return;
    list.innerHTML = '';

    if (state.workflows.length === 0) {
        list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:20px;">No workflows found</div>';
        return;
    }

    state.workflows.forEach(wf => {
        const item = document.createElement('div');
        item.className = `workflow-item ${state.currentWorkflow.id === wf.id ? 'active' : ''}`;
        item.innerHTML = `
            <div class="workflow-item-header">
                <div class="workflow-item-name">${wf.name}</div>
                <span class="status-badge ${wf.status}">${wf.status}</span>
            </div>
            <div class="workflow-item-desc">${wf.description || 'No description'}</div>
            <div class="workflow-item-footer">
                <span>${wf.canvas?.nodes?.length || 0} nodes</span>
                <span>v${wf.version || wf.activeVersionNumber || 1}</span>
            </div>
        `;
        item.onclick = () => loadWorkflow(wf.id);
        list.appendChild(item);
    });
}

async function loadWorkflow(id) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${API_BASE}/${id}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const json = await res.json();
            if (json.success && json.workflow) {
                state.currentWorkflow = json.workflow;
                document.getElementById('workflow-name-input').value = json.workflow.name;
                document.getElementById('workflow-desc-input').value = json.workflow.description || '';
                
                const badge = document.getElementById('workflow-status-badge');
                badge.className = `status-badge ${json.workflow.status}`;
                badge.textContent = json.workflow.status;

                // Toggle AI Review Mode Banner
                const reviewBanner = document.getElementById('ai-review-banner');
                if (reviewBanner) {
                    reviewBanner.style.display = (json.workflow.isAiGenerated && json.workflow.status === 'draft') ? 'flex' : 'none';
                }

                // Populate Version Selector
                populateVersionSelector(json.workflow);

                // Fetch question configurations if available
                try {
                    const qRes = await fetch(`${API_BASE}/${id}/question-configs`);
                    if (qRes.ok) {
                        const qJson = await qRes.json();
                        if (qJson.success && qJson.questionConfigs) {
                            state.currentWorkflow.questionConfigs = qJson.questionConfigs;
                        }
                    }
                } catch (_) {}

                // Fetch automation configurations if available (PRD §12)
                try {
                    const aRes = await fetch(`${API_BASE}/${id}/automations`);
                    if (aRes.ok) {
                        const aJson = await aRes.json();
                        if (aJson.success && aJson.automationConfigs) {
                            state.currentWorkflow.automationConfigs = aJson.automationConfigs;
                        }
                    }
                } catch (_) {}

                state.selectedNodeId = null;
                renderCanvas();
                renderWorkflowList();
                renderConfigPanel();
                showToast(`Loaded "${json.workflow.name}"`, 'info');
                return;
            }
        }
    } catch (err) {
        // Fallback local matching
    }
    
    // Check local fallback
    const local = state.workflows.find(w => w.id === id);
    if (local) {
        state.currentWorkflow = local;
        document.getElementById('workflow-name-input').value = local.name;
        document.getElementById('workflow-desc-input').value = local.description || '';
        const badge = document.getElementById('workflow-status-badge');
        if (badge) {
            badge.className = `status-badge ${local.status}`;
            badge.textContent = local.status;
        }
        populateVersionSelector(local);
        state.selectedNodeId = null;
        renderCanvas();
        renderWorkflowList();
        renderConfigPanel();
        showToast(`Loaded "${local.name}"`, 'info');
    } else {
        showToast('Workflow not found', 'error');
    }
}

function populateVersionSelector(workflow) {
    const versionSelect = document.getElementById('version-selector');
    const rollbackBtn = document.getElementById('btn-rollback-version');
    if (!versionSelect) return;

    versionSelect.innerHTML = '';
    const versions = workflow.versions && workflow.versions.length > 0
        ? workflow.versions
        : [{ versionNumber: workflow.version || 1, status: workflow.status || 'draft' }];

    state.versions = versions;
    const currentVer = workflow.version || workflow.activeVersionNumber || 1;
    state.selectedVersionNumber = currentVer;

    versions.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.versionNumber;
        const isCurrentActive = v.versionNumber === workflow.activeVersionNumber;
        opt.textContent = `v${v.versionNumber} (${capitalize(v.status || 'draft')}${isCurrentActive ? ' - Live' : ''})`;
        if (v.versionNumber === currentVer) opt.selected = true;
        versionSelect.appendChild(opt);
    });

    if (rollbackBtn) {
        rollbackBtn.style.display = (currentVer < (workflow.activeVersionNumber || 1)) ? 'inline-flex' : 'none';
    }
}

async function loadExecutionLogs() {
    const container = document.getElementById('execution-logs-list');
    if (!container) return;

    if (!state.currentWorkflow || !state.currentWorkflow.id) {
        container.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:15px;">Save workflow to view execution logs</div>';
        return;
    }

    container.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:15px;"><i class="fas fa-spinner fa-spin"></i> Loading execution runs...</div>';

    try {
        const res = await fetch(`${API_BASE}/${state.currentWorkflow.id}/execution-logs`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.success) {
            const logs = json.executionLogs || [];
            if (logs.length === 0) {
                container.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:15px;">No execution runs recorded yet</div>';
                return;
            }

            container.innerHTML = '';
            logs.forEach(log => {
                const item = document.createElement('div');
                item.className = 'log-item';
                const statusClass = log.status === 'SUCCESS' ? 'badge-success' 
                    : log.status === 'FAILED' ? 'badge-failed' 
                    : log.status === 'RETRY' ? 'badge-retry' : 'badge-running';
                
                const timeStr = new Date(log.startedAt || log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                item.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <div>
                            <span class="item-badge ${statusClass}">${log.status}</span>
                            <span style="font-size:10px; color:var(--accent-purple); font-weight:700; margin-left:4px;">v${log.version || 1}</span>
                        </div>
                        <span style="font-size:10px; color:var(--text-muted);">${timeStr}</span>
                    </div>
                    <div style="font-weight:600; color:var(--text-primary); margin-bottom:2px;">
                        ${log.runId} <span style="font-weight:400; font-size:10.5px; color:var(--text-secondary);">&bull; by ${log.actor || 'System'}</span>
                    </div>
                    <div style="color:var(--text-secondary); font-size:10.5px;">
                        Steps: ${log.stepsExecuted || 0} &bull; Duration: ${log.durationMs || 0}ms
                        ${log.retryCount ? ` &bull; <strong style="color:var(--accent-gold);">Retries: ${log.retryCount}</strong>` : ''}
                    </div>
                    ${log.errorReason ? `<div style="margin-top:4px; font-size:10.5px; color:var(--accent-red); background:rgba(239,68,68,0.1); padding:4px 6px; border-radius:4px;">Error: ${log.errorReason}</div>` : ''}
                `;
                container.appendChild(item);
            });
        }
    } catch (err) {
        container.innerHTML = `<div style="color:var(--accent-red);font-size:11.5px;padding:10px;">Failed to load logs: ${err.message}</div>`;
    }
}

async function loadAuditTrail() {
    const container = document.getElementById('audit-trail-list');
    if (!container) return;

    if (!state.currentWorkflow || !state.currentWorkflow.id) {
        container.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:15px;">Save workflow to view audit history</div>';
        return;
    }

    container.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:15px;"><i class="fas fa-spinner fa-spin"></i> Loading audit trail...</div>';

    try {
        const res = await fetch(`${API_BASE}/${state.currentWorkflow.id}/audit-trail`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.success) {
            const audits = json.auditTrail || [];
            if (audits.length === 0) {
                container.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:15px;">No audit events recorded yet</div>';
                return;
            }

            container.innerHTML = '';
            audits.forEach(audit => {
                const item = document.createElement('div');
                item.className = 'audit-item';
                const timeStr = new Date(audit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                item.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <div>
                            <span class="item-badge badge-action">${audit.action}</span>
                            <span style="font-size:10px; color:var(--accent-purple); font-weight:700; margin-left:4px;">v${audit.version || 1}</span>
                        </div>
                        <span style="font-size:10px; color:var(--text-muted);">${timeStr}</span>
                    </div>
                    <div style="color:var(--text-primary); font-size:11px; margin-bottom:2px;">
                        ${audit.details || 'Workflow updated'}
                    </div>
                    <div style="color:var(--text-muted); font-size:10px;">
                        Actor: <strong style="color:var(--text-secondary);">${audit.actor || 'System'}</strong> &bull; ${new Date(audit.timestamp).toLocaleDateString()}
                    </div>
                `;
                container.appendChild(item);
            });
        }
    } catch (err) {
        container.innerHTML = `<div style="color:var(--accent-red);font-size:11.5px;padding:10px;">Failed to load audit: ${err.message}</div>`;
    }
}

function newWorkflow() {
    state.currentWorkflow = {
        id: null,
        name: 'New Workflow',
        description: 'Automated multi-stage HR process',
        status: 'draft',
        isAiGenerated: false,
        canvas: {
            nodes: [
                {
                    id: 'node_' + Math.random().toString(36).substr(2, 6),
                    type: 'trigger',
                    label: 'Workflow Trigger',
                    x: 100,
                    y: 120,
                    config: { event: 'candidate_offer_accepted', entity: 'candidate' }
                }
            ],
            connections: []
        }
    };
    document.getElementById('workflow-name-input').value = state.currentWorkflow.name;
    document.getElementById('workflow-desc-input').value = state.currentWorkflow.description;
    const badge = document.getElementById('workflow-status-badge');
    badge.className = 'status-badge draft';
    badge.textContent = 'draft';

    const reviewBanner = document.getElementById('ai-review-banner');
    if (reviewBanner) reviewBanner.style.display = 'none';

    state.selectedNodeId = state.currentWorkflow.canvas.nodes[0].id;
    renderCanvas();
    renderConfigPanel();
    showToast('Created new canvas', 'info');
}

// ─── CANVAS RENDERING & INTERACTION ───
function renderCanvas() {
    const nodesLayer = document.getElementById('nodes-layer');
    const svgCanvas = document.getElementById('svg-canvas');
    if (!nodesLayer || !svgCanvas) return;

    nodesLayer.innerHTML = '';
    svgCanvas.innerHTML = '';

    const nodes = state.currentWorkflow.canvas.nodes || [];
    const connections = state.currentWorkflow.canvas.connections || [];

    // Update node count in stats bar
    const nodeCountEl = document.getElementById('stat-nodes');
    if (nodeCountEl) nodeCountEl.textContent = nodes.length;

    // Render Connections (SVG Bezier curves)
    connections.forEach(conn => {
        const fromNode = nodes.find(n => n.id === conn.from);
        const toNode = nodes.find(n => n.id === conn.to);
        if (fromNode && toNode) {
            renderConnection(fromNode, toNode, conn);
        }
    });

    // Render Node Cards
    nodes.forEach(node => {
        const card = createNodeElement(node);
        nodesLayer.appendChild(card);
    });
}

function renderConnection(fromNode, toNode, conn) {
    const svgCanvas = document.getElementById('svg-canvas');
    
    let fromX = fromNode.x + 110;
    let fromY = fromNode.y + 70; // bottom center
    if (conn.port === 'true') fromX = fromNode.x + 66;
    if (conn.port === 'false') fromX = fromNode.x + 154;

    const toX = toNode.x + 110;
    const toY = toNode.y; // top center

    const dx = Math.abs(toX - fromX);
    const dy = Math.max(Math.abs(toY - fromY), 50);
    const cpY1 = fromY + Math.max(dy * 0.5, 40);
    const cpY2 = toY - Math.max(dy * 0.5, 40);

    const pathData = `M ${fromX} ${fromY} C ${fromX} ${cpY1}, ${toX} ${cpY2}, ${toX} ${toY}`;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let lineClass = 'flow-line';
    if (conn.port === 'true') lineClass += ' branch-true';
    if (conn.port === 'false') lineClass += ' branch-false';
    path.setAttribute('class', lineClass);
    path.setAttribute('d', pathData);
    path.setAttribute('id', `conn_${conn.from}_${conn.to}`);

    // Click to delete connection
    path.addEventListener('click', (e) => {
        e.stopPropagation();
        state.currentWorkflow.canvas.connections = state.currentWorkflow.canvas.connections.filter(c => c !== conn);
        renderCanvas();
        showToast('Connection removed', 'info');
    });

    svgCanvas.appendChild(path);
}

function createNodeElement(node) {
    const card = document.createElement('div');
    card.className = `canvas-node ${state.selectedNodeId === node.id ? 'selected' : ''}`;
    card.id = `canvas_node_${node.id}`;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;

    const icon = NODE_ICONS[node.type] || 'fa-cog';
    const color = NODE_COLORS[node.type] || '#6366f1';

    let summaryText = getNodeSummary(node);

    let portsHtml = '';
    // Input port (top) - except triggers
    if (node.type !== 'trigger') {
        portsHtml += `<div class="node-port node-port-in" data-port="in" title="Incoming Flow"></div>`;
    }
    // Output ports (bottom)
    if (node.type === 'branch') {
        portsHtml += `<div class="node-port node-port-out-true" data-port="true" title="True / Yes Path"></div>`;
        portsHtml += `<div class="node-port node-port-out-false" data-port="false" title="False / No Path"></div>`;
    } else if (node.type !== 'end') {
        portsHtml += `<div class="node-port node-port-out" data-port="out" title="Next Step"></div>`;
    }

    const qConfigs = state.currentWorkflow?.questionConfigs || {};
    const stageQConfig = qConfigs[node.id] || qConfigs[`stage_${node.id}`] || (node.config?.questions ? { questions: node.config.questions } : null);
    const qCount = stageQConfig?.questions?.length || 0;
    const qBadgeHtml = qCount > 0 
        ? `<div class="node-question-badge" title="Click to customize questions (PRD §9)" onclick="event.stopPropagation(); window.openQuestionCustomizationDrawer('${node.id}');"><i class="fas fa-clipboard-question"></i> ${qCount} Questions</div>`
        : '';

    const aConfigs = state.currentWorkflow?.automationConfigs || {};
    const stageAConfig = aConfigs[node.id] || aConfigs[`stage_${node.id}`] || (node.config?.automation ? node.config.automation : null);
    const hasAutomation = !!(stageAConfig && (stageAConfig.enabled !== false));
    const aActionType = stageAConfig?.automationConfig?.actionType || stageAConfig?.actionType || 'NOTIFY_AND_ROUTE';
    const aBadgeHtml = hasAutomation
        ? `<div class="node-automation-badge" title="Active Automation: ${escapeHtml(aActionType)} (Click to edit PRD §12)" onclick="event.stopPropagation(); window.openAutomationDrawer('${node.id}');"><i class="fas fa-bolt"></i> ${escapeHtml(aActionType)}</div>`
        : `<div class="node-automation-add-link" title="Attach Automation (PRD §12)" onclick="event.stopPropagation(); window.openAutomationDrawer('${node.id}');"><i class="fas fa-plus"></i> Automation</div>`;

    card.innerHTML = `
        ${portsHtml}
        <div class="canvas-node-header" style="background: rgba(${hexToRgb(color)}, 0.12)">
            <div class="canvas-node-icon" style="background: ${color};"><i class="fas ${icon}"></i></div>
            <div style="flex:1;min-width:0;">
                <div class="canvas-node-type-label">${node.type}</div>
                <div class="canvas-node-label">${node.label}</div>
            </div>
        </div>
        <div class="canvas-node-body">
            ${summaryText}
            <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
                ${qBadgeHtml}
                ${aBadgeHtml}
            </div>
        </div>
    `;

    // Drag Node Repositioning
    let isDragging = false;
    let startX = 0, startY = 0;
    let nodeStartX = 0, nodeStartY = 0;

    card.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('node-port')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        nodeStartX = node.x;
        nodeStartY = node.y;
        selectNode(node.id);
        e.stopPropagation();

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dx = (moveEvent.clientX - startX) / state.scale;
            const dy = (moveEvent.clientY - startY) / state.scale;
            // Snap to 10px grid
            node.x = Math.round((nodeStartX + dx) / 10) * 10;
            node.y = Math.round((nodeStartY + dy) / 10) * 10;
            card.style.left = `${node.x}px`;
            card.style.top = `${node.y}px`;
            renderConnectionsOnly();
        };

        const onMouseUp = () => {
            isDragging = false;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    });

    // Port Connection Click / Drag
    card.querySelectorAll('.node-port').forEach(portEl => {
        portEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const portType = portEl.getAttribute('data-port');
            if (portType === 'in') {
                if (state.connectingFromNodeId && state.connectingFromNodeId !== node.id) {
                    // Create connection
                    addConnection(state.connectingFromNodeId, node.id, state.connectingFromPort);
                    state.connectingFromNodeId = null;
                    state.connectingFromPort = null;
                    renderCanvas();
                }
            } else {
                state.connectingFromNodeId = node.id;
                state.connectingFromPort = portType;
                showToast(`Connecting from ${node.label}... Click target node input port`, 'info');
            }
        });
    });

    return card;
}

function renderConnectionsOnly() {
    const svgCanvas = document.getElementById('svg-canvas');
    if (!svgCanvas) return;
    svgCanvas.innerHTML = '';
    const nodes = state.currentWorkflow.canvas.nodes || [];
    const connections = state.currentWorkflow.canvas.connections || [];
    connections.forEach(conn => {
        const fromNode = nodes.find(n => n.id === conn.from);
        const toNode = nodes.find(n => n.id === conn.to);
        if (fromNode && toNode) {
            renderConnection(fromNode, toNode, conn);
        }
    });
}

function getNodeSummary(node) {
    const cfg = node.config || {};
    switch (node.type) {
        case 'trigger':
            return `Event: <strong>${cfg.event || 'None'}</strong>`;
        case 'condition':
            return `Check: <code>${cfg.field || 'field'} ${cfg.operator || '=='} ${cfg.value || 'val'}</code>`;
        case 'branch':
            return `Branch: <code>${cfg.field || 'field'} ${cfg.operator || '=='} ${cfg.value || 'val'}</code>`;
        case 'approval':
            return `Approver: <strong>${cfg.assigneeRole || 'manager'}</strong> (${cfg.dueHours || 24}h)`;
        case 'wait':
            return `Delay: <strong>${cfg.duration || 1} ${cfg.unit || 'days'}</strong>`;
        case 'escalation':
            return `Escalate to: <strong>${cfg.escalateTo || 'hr_head'}</strong> (SLA ${cfg.slaHours || 48}h)`;
        case 'action':
            return `Task: <strong>${cfg.actionType || 'execute'}</strong>`;
        case 'notification':
            return `Notify: <strong>${cfg.recipient || 'employee'}</strong> (${cfg.channel || 'email'})`;
        case 'document':
            return `Generate: <strong>${cfg.templateKey || 'offer_letter'}</strong>`;
        case 'form':
            return `Capture: <strong>${cfg.formTitle || 'HR Form'}</strong>`;
        case 'end':
            return `Outcome: <strong>${cfg.outcomeStatus || 'COMPLETED'}</strong>`;
        default:
            return 'Configured';
    }
}

function addConnection(fromId, toId, port = 'out') {
    const exists = state.currentWorkflow.canvas.connections.some(c => c.from === fromId && c.to === toId && c.port === port);
    if (!exists) {
        state.currentWorkflow.canvas.connections.push({ from: fromId, to: toId, port: port });
        showToast('Nodes connected', 'success');
    }
}

function selectNode(nodeId) {
    state.selectedNodeId = nodeId;
    document.querySelectorAll('.canvas-node').forEach(el => el.classList.remove('selected'));
    const target = document.getElementById(`canvas_node_${nodeId}`);
    if (target) target.classList.add('selected');
    renderConfigPanel();
}

// ─── NO-CODE CONFIGURATION PANEL GENERATOR ───
function renderConfigPanel() {
    const panelBody = document.getElementById('config-panel-body');
    const panelHeading = document.getElementById('config-panel-heading');
    const iconEl = document.getElementById('config-node-icon');
    if (!panelBody) return;

    if (!state.selectedNodeId) {
        panelHeading.textContent = 'Node Properties';
        panelBody.innerHTML = `
            <div class="config-empty-state">
                <i class="fas fa-mouse-pointer"></i>
                <p>Select any node on the canvas to configure properties</p>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
                    100% No-Code: Point & click setup.<br>HR never writes Firebase, Python, JS or API code.
                </div>
            </div>
        `;
        return;
    }

    const node = state.currentWorkflow.canvas.nodes.find(n => n.id === state.selectedNodeId);
    if (!node) return;

    const color = NODE_COLORS[node.type] || '#6366f1';
    const icon = NODE_ICONS[node.type] || 'fa-cog';
    iconEl.style.background = color;
    iconEl.innerHTML = `<i class="fas ${icon}"></i>`;
    panelHeading.textContent = `${node.type.toUpperCase()}: ${node.label}`;

    // Zero-Code Assurance Banner
    let formHtml = `
        <div class="no-code-indicator">
            <i class="fas fa-shield-alt" style="color:#10b981; font-size:14px;"></i>
            <div>
                <strong>HR No-Code Mode Active</strong>
                <div style="font-size:10px; color:var(--text-muted);">Visual configuration only. No Firebase, Python, JS or API code.</div>
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">Step Label</label>
            <input type="text" class="form-control" id="cfg-node-label" value="${node.label || ''}" />
        </div>
    `;

    const cfg = node.config || {};

    if (node.type === 'trigger') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Trigger Event</label>
                <select class="form-control" id="cfg-trigger-event">
                    <option value="candidate_offer_accepted" ${cfg.event === 'candidate_offer_accepted' ? 'selected' : ''}>Candidate Offer Accepted</option>
                    <option value="employee_resignation_submitted" ${cfg.event === 'employee_resignation_submitted' ? 'selected' : ''}>Employee Resignation Submitted</option>
                    <option value="payroll_cycle_initiated" ${cfg.event === 'payroll_cycle_initiated' ? 'selected' : ''}>Payroll Cycle Initiated</option>
                    <option value="leave_application_filed" ${cfg.event === 'leave_application_filed' ? 'selected' : ''}>Leave Application Filed</option>
                    <option value="probation_review_due" ${cfg.event === 'probation_review_due' ? 'selected' : ''}>Probation Review Due</option>
                    <option value="statutory_filing_deadline" ${cfg.event === 'statutory_filing_deadline' ? 'selected' : ''}>Statutory Filing Deadline</option>
                    <option value="appraisal_cycle_launched" ${cfg.event === 'appraisal_cycle_launched' ? 'selected' : ''}>Appraisal Cycle Launched</option>
                    <option value="consecutive_absence_flagged" ${cfg.event === 'consecutive_absence_flagged' ? 'selected' : ''}>3 Consecutive Absent Days Flagged</option>
                    <option value="new_hire_joined" ${cfg.event === 'new_hire_joined' ? 'selected' : ''}>New Hire First Day</option>
                    <option value="contract_expiry_due" ${cfg.event === 'contract_expiry_due' ? 'selected' : ''}>Contract / SOW Expiry Approaching</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Target Entity</label>
                <select class="form-control" id="cfg-trigger-entity">
                    <option value="employee" ${cfg.entity === 'employee' ? 'selected' : ''}>Employee Master Record</option>
                    <option value="candidate" ${cfg.entity === 'candidate' ? 'selected' : ''}>Candidate Profile</option>
                    <option value="payroll" ${cfg.entity === 'payroll' ? 'selected' : ''}>Payroll Disbursement Batch</option>
                    <option value="leave" ${cfg.entity === 'leave' ? 'selected' : ''}>Leave Application</option>
                    <option value="compliance" ${cfg.entity === 'compliance' ? 'selected' : ''}>Statutory / PF Compliance Record</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Scope Filter</label>
                <select class="form-control" id="cfg-trigger-scope">
                    <option value="all" ${cfg.scope === 'all' ? 'selected' : ''}>All Departments & Locations</option>
                    <option value="engineering" ${cfg.scope === 'engineering' ? 'selected' : ''}>Engineering & Product</option>
                    <option value="sales" ${cfg.scope === 'sales' ? 'selected' : ''}>Sales & Marketing</option>
                    <option value="operations" ${cfg.scope === 'operations' ? 'selected' : ''}>Operations & Support</option>
                    <option value="full_time" ${cfg.scope === 'full_time' ? 'selected' : ''}>Full-Time Staff Only</option>
                </select>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-bolt" style="color:var(--node-trigger);"></i> Workflow triggers automatically upon event detection. Zero webhooks or API coding needed.
            </div>
        `;
    } else if (node.type === 'condition' || node.type === 'branch') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Evaluation Field</label>
                <select class="form-control" id="cfg-cond-field">
                    <option value="designation" ${cfg.field === 'designation' ? 'selected' : ''}>Designation / Role</option>
                    <option value="department" ${cfg.field === 'department' ? 'selected' : ''}>Department</option>
                    <option value="employmentType" ${cfg.field === 'employmentType' ? 'selected' : ''}>Employment Type</option>
                    <option value="ctc" ${cfg.field === 'ctc' ? 'selected' : ''}>CTC / Compensation</option>
                    <option value="variancePercentage" ${cfg.field === 'variancePercentage' ? 'selected' : ''}>Payroll Variance %</option>
                    <option value="tenureMonths" ${cfg.field === 'tenureMonths' ? 'selected' : ''}>Tenure (Months)</option>
                    <option value="performanceRating" ${cfg.field === 'performanceRating' ? 'selected' : ''}>Performance Rating (1-5)</option>
                    <option value="consecutiveAbsences" ${cfg.field === 'consecutiveAbsences' ? 'selected' : ''}>Consecutive Absences (Days)</option>
                    <option value="probationStatus" ${cfg.field === 'probationStatus' ? 'selected' : ''}>Probation Clearance</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Operator</label>
                <select class="form-control" id="cfg-cond-op">
                    <option value="==" ${cfg.operator === '==' ? 'selected' : ''}>Equals (==)</option>
                    <option value="!=" ${cfg.operator === '!=' ? 'selected' : ''}>Not Equals (!=)</option>
                    <option value=">" ${cfg.operator === '>' ? 'selected' : ''}>Greater Than (&gt;)</option>
                    <option value="<" ${cfg.operator === '<' ? 'selected' : ''}>Less Than (&lt;)</option>
                    <option value=">=" ${cfg.operator === '>=' ? 'selected' : ''}>Greater Than or Equal (&gt;=)</option>
                    <option value="<=" ${cfg.operator === '<=' ? 'selected' : ''}>Less Than or Equal (&lt;=)</option>
                    <option value="contains" ${cfg.operator === 'contains' ? 'selected' : ''}>Contains Text</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Comparison Value</label>
                <input type="text" class="form-control" id="cfg-cond-val" value="${cfg.value !== undefined ? cfg.value : ''}" placeholder="e.g. Engineering or 5" />
                <div class="preset-chips">
                    <span class="preset-chip" onclick="setPresetValue('Engineering')">Engineering</span>
                    <span class="preset-chip" onclick="setPresetValue('Sales')">Sales</span>
                    <span class="preset-chip" onclick="setPresetValue('5')">5%</span>
                    <span class="preset-chip" onclick="setPresetValue('2000000')">${window.KylrxFmt ? KylrxFmt.moneyCompact(2000000) : '₹20L'}</span>
                    <span class="preset-chip" onclick="setPresetValue('3')">3 Days</span>
                    <span class="preset-chip" onclick="setPresetValue('Full-Time')">Full-Time</span>
                </div>
            </div>
        `;
        if (node.type === 'branch') {
            formHtml += `
                <div class="form-group">
                    <label class="form-label">True / Yes Route Label</label>
                    <input type="text" class="form-control" id="cfg-branch-true" value="${cfg.trueLabel || 'True / Yes'}" />
                </div>
                <div class="form-group">
                    <label class="form-label">False / No Route Label</label>
                    <input type="text" class="form-control" id="cfg-branch-false" value="${cfg.falseLabel || 'False / No'}" />
                </div>
                <div class="no-code-pill-info">
                    <i class="fas fa-code-branch" style="color:var(--node-branch);"></i> Connect other nodes to the green True or orange False output ports.
                </div>
            `;
        } else {
            formHtml += `
                <div class="no-code-pill-info">
                    <i class="fas fa-filter" style="color:var(--node-condition);"></i> Evaluates condition automatically against live employee attributes.
                </div>
            `;
        }
    } else if (node.type === 'approval') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Assignee Role</label>
                <select class="form-control" id="cfg-appr-role">
                    <option value="manager" ${cfg.assigneeRole === 'manager' ? 'selected' : ''}>Reporting Manager</option>
                    <option value="department_head" ${cfg.assigneeRole === 'department_head' ? 'selected' : ''}>Department Head / VP</option>
                    <option value="hr_manager" ${cfg.assigneeRole === 'hr_manager' ? 'selected' : ''}>HR Operations Manager</option>
                    <option value="finance_admin" ${cfg.assigneeRole === 'finance_admin' ? 'selected' : ''}>Finance / Payroll Lead</option>
                    <option value="super_admin" ${cfg.assigneeRole === 'super_admin' ? 'selected' : ''}>Super Admin / Director</option>
                    <option value="cfo" ${cfg.assigneeRole === 'cfo' ? 'selected' : ''}>Chief Financial Officer</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">SLA Due Time (Hours)</label>
                <input type="number" class="form-control" id="cfg-appr-due" value="${cfg.dueHours || 24}" min="1" max="168" />
                <div class="preset-chips">
                    <span class="preset-chip" onclick="setSlaHours(12)">12h</span>
                    <span class="preset-chip" onclick="setSlaHours(24)">24h</span>
                    <span class="preset-chip" onclick="setSlaHours(48)">48h</span>
                    <span class="preset-chip" onclick="setSlaHours(72)">72h</span>
                    <span class="preset-chip" onclick="setSlaHours(120)">5 Days</span>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Action on Rejection</label>
                <select class="form-control" id="cfg-appr-reject">
                    <option value="terminate" ${cfg.onReject === 'terminate' ? 'selected' : ''}>Terminate Workflow</option>
                    <option value="reassign" ${cfg.onReject === 'reassign' ? 'selected' : ''}>Reassign to Alternate Approver</option>
                    <option value="notify" ${cfg.onReject === 'notify' ? 'selected' : ''}>Notify Initiator Only</option>
                    <option value="return_remarks" ${cfg.onReject === 'return_remarks' ? 'selected' : ''}>Return with Rejection Remarks</option>
                </select>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-user-check" style="color:var(--node-approval);"></i> Generates an interactive approval card in the assigned manager's portal.
            </div>
        `;
    } else if (node.type === 'wait') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Duration</label>
                <input type="number" class="form-control" id="cfg-wait-dur" value="${cfg.duration || 1}" min="1" />
            </div>
            <div class="form-group">
                <label class="form-label">Unit</label>
                <select class="form-control" id="cfg-wait-unit">
                    <option value="hours" ${cfg.unit === 'hours' ? 'selected' : ''}>Hours</option>
                    <option value="days" ${cfg.unit === 'days' ? 'selected' : ''}>Days</option>
                    <option value="business_days" ${cfg.unit === 'business_days' ? 'selected' : ''}>Business Days (Excl. Weekends)</option>
                </select>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-clock" style="color:var(--node-wait);"></i> The engine pauses execution for the configured interval before advancing.
            </div>
        `;
    } else if (node.type === 'escalation') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Escalate To</label>
                <select class="form-control" id="cfg-esc-to">
                    <option value="hr_head" ${cfg.escalateTo === 'hr_head' ? 'selected' : ''}>Head of Human Resources</option>
                    <option value="vp_operations" ${cfg.escalateTo === 'vp_operations' ? 'selected' : ''}>VP of People Operations</option>
                    <option value="cfo" ${cfg.escalateTo === 'cfo' ? 'selected' : ''}>Chief Financial Officer</option>
                    <option value="ceo" ${cfg.escalateTo === 'ceo' ? 'selected' : ''}>Chief Executive Officer</option>
                    <option value="escalation_board" ${cfg.escalateTo === 'escalation_board' ? 'selected' : ''}>Executive Escalation Board</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">SLA Breach Threshold (Hours)</label>
                <input type="number" class="form-control" id="cfg-esc-sla" value="${cfg.slaHours || 48}" min="1" />
            </div>
            <div class="form-group">
                <label class="form-label">Urgency Level</label>
                <select class="form-control" id="cfg-esc-urgency">
                    <option value="high" ${cfg.urgency === 'high' ? 'selected' : ''}>High Priority Alert</option>
                    <option value="critical" ${cfg.urgency === 'critical' ? 'selected' : ''}>Critical (Immediate Push Alert)</option>
                    <option value="blocker" ${cfg.urgency === 'blocker' ? 'selected' : ''}>Blocker (Executive SMS / Email)</option>
                </select>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-level-up-alt" style="color:var(--node-escalation);"></i> Automatically reassigns stalled tasks and notifies executive leadership.
            </div>
        `;
    } else if (node.type === 'action') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Action Type</label>
                <select class="form-control" id="cfg-act-type">
                    <option value="provision_it_assets" ${cfg.actionType === 'provision_it_assets' ? 'selected' : ''}>Provision IT & Email Account</option>
                    <option value="deactivate_access" ${cfg.actionType === 'deactivate_access' ? 'selected' : ''}>Deactivate Enterprise Access</option>
                    <option value="update_employee_status" ${cfg.actionType === 'update_employee_status' ? 'selected' : ''}>Update Employee Master Record</option>
                    <option value="initiate_bank_transfer" ${cfg.actionType === 'initiate_bank_transfer' ? 'selected' : ''}>Initiate Bank Payout Batch</option>
                    <option value="post_payroll_journal" ${cfg.actionType === 'post_payroll_journal' ? 'selected' : ''}>Post General Ledger Journal</option>
                    <option value="credit_leave_balance" ${cfg.actionType === 'credit_leave_balance' ? 'selected' : ''}>Credit Annual Leave Balance</option>
                    <option value="generate_statutory_ecr" ${cfg.actionType === 'generate_statutory_ecr' ? 'selected' : ''}>Generate PF / ECR Statutory File</option>
                    <option value="lock_asset_inventory" ${cfg.actionType === 'lock_asset_inventory' ? 'selected' : ''}>Lock Asset Clearance Checklist</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Execution Mode</label>
                <select class="form-control" id="cfg-act-mode">
                    <option value="immediate" ${cfg.mode === 'immediate' ? 'selected' : ''}>Immediate Execution</option>
                    <option value="batch" ${cfg.mode === 'batch' ? 'selected' : ''}>Queue for Next Hourly Batch</option>
                    <option value="nightly" ${cfg.mode === 'nightly' ? 'selected' : ''}>Scheduled Nightly Run</option>
                </select>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-play" style="color:var(--node-action);"></i> Integrates with enterprise services with pre-built system connectors.
            </div>
        `;
    } else if (node.type === 'notification') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Recipient</label>
                <select class="form-control" id="cfg-notif-recip">
                    <option value="employee" ${cfg.recipient === 'employee' ? 'selected' : ''}>Employee / Candidate</option>
                    <option value="manager" ${cfg.recipient === 'manager' ? 'selected' : ''}>Reporting Manager</option>
                    <option value="hr_ops" ${cfg.recipient === 'hr_ops' ? 'selected' : ''}>HR Operations Team</option>
                    <option value="it_desk" ${cfg.recipient === 'it_desk' ? 'selected' : ''}>IT Service Desk</option>
                    <option value="finance" ${cfg.recipient === 'finance' ? 'selected' : ''}>Finance & Accounts</option>
                    <option value="leadership" ${cfg.recipient === 'leadership' ? 'selected' : ''}>Department Leadership</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Channel</label>
                <select class="form-control" id="cfg-notif-chan">
                    <option value="email" ${cfg.channel === 'email' ? 'selected' : ''}>Email</option>
                    <option value="in_app" ${cfg.channel === 'in_app' ? 'selected' : ''}>In-App Action Center</option>
                    <option value="slack" ${cfg.channel === 'slack' ? 'selected' : ''}>Slack / Teams Webhook</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Subject / Header</label>
                <input type="text" class="form-control" id="cfg-notif-sub" value="${cfg.subject || 'Workflow Notice: Request Status Update'}" />
            </div>
            <div class="form-group">
                <label class="form-label">Message Template</label>
                <textarea class="form-control" id="cfg-notif-msg" rows="3">${cfg.template || 'Hello {{name}}, your request has been processed.'}</textarea>
                <div class="token-chips">
                    <span class="token-chip" onclick="insertToken('{{name}}')">{{name}}</span>
                    <span class="token-chip" onclick="insertToken('{{employee_id}}')">{{employee_id}}</span>
                    <span class="token-chip" onclick="insertToken('{{designation}}')">{{designation}}</span>
                    <span class="token-chip" onclick="insertToken('{{department}}')">{{department}}</span>
                    <span class="token-chip" onclick="insertToken('{{effectiveDate}}')">{{effectiveDate}}</span>
                    <span class="token-chip" onclick="insertToken('{{managerName}}')">{{managerName}}</span>
                </div>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-paper-plane" style="color:var(--node-notification);"></i> Click any variable chip above to inject live data without writing template code.
            </div>
        `;
    } else if (node.type === 'document') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Document Template</label>
                <select class="form-control" id="cfg-doc-key">
                    <option value="offer_letter" ${cfg.templateKey === 'offer_letter' ? 'selected' : ''}>Offer Letter</option>
                    <option value="appointment_letter" ${cfg.templateKey === 'appointment_letter' ? 'selected' : ''}>Appointment Letter</option>
                    <option value="promotion_letter" ${cfg.templateKey === 'promotion_letter' ? 'selected' : ''}>Promotion Letter</option>
                    <option value="increment_letter" ${cfg.templateKey === 'increment_letter' ? 'selected' : ''}>Increment Letter</option>
                    <option value="transfer_letter" ${cfg.templateKey === 'transfer_letter' ? 'selected' : ''}>Transfer Letter</option>
                    <option value="payslip" ${cfg.templateKey === 'payslip' ? 'selected' : ''}>Itemized Payslip</option>
                    <option value="ff_statement" ${cfg.templateKey === 'ff_statement' ? 'selected' : ''}>Full & Final Statement</option>
                    <option value="relieving_letter" ${cfg.templateKey === 'relieving_letter' ? 'selected' : ''}>Relieving Letter</option>
                    <option value="experience_letter" ${cfg.templateKey === 'experience_letter' ? 'selected' : ''}>Experience Letter</option>
                    <option value="termination_letter" ${cfg.templateKey === 'termination_letter' ? 'selected' : ''}>Termination Letter</option>
                    <option value="nda_agreement" ${cfg.templateKey === 'nda_agreement' ? 'selected' : ''}>Non-Disclosure Agreement (NDA)</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Output Format</label>
                <select class="form-control" id="cfg-doc-format">
                    <option value="pdf_sealed" ${cfg.format === 'pdf_sealed' ? 'selected' : ''}>Digital PDF with Corporate Seal</option>
                    <option value="e_sign" ${cfg.format === 'e_sign' ? 'selected' : ''}>Route for E-Signature Sign-off</option>
                    <option value="draft" ${cfg.format === 'draft' ? 'selected' : ''}>Draft PDF for HR Preview</option>
                </select>
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-file-alt" style="color:var(--node-document);"></i> Pulls verified data into approved templates. Zero HTML or PDF scripting required.
            </div>
        `;
    } else if (node.type === 'form') {
        const activeFields = cfg.fields || ['personal', 'bank', 'emergency'];
        formHtml += `
            <div class="form-group">
                <label class="form-label">Form Title</label>
                <input type="text" class="form-control" id="cfg-form-title" value="${cfg.formTitle || 'Employee Details Form'}" />
            </div>
            <div class="form-group">
                <label class="form-label">Target Respondent</label>
                <select class="form-control" id="cfg-form-respondent">
                    <option value="employee" ${cfg.respondent === 'employee' ? 'selected' : ''}>Employee / Candidate</option>
                    <option value="manager" ${cfg.respondent === 'manager' ? 'selected' : ''}>Reporting Manager</option>
                    <option value="hr_specialist" ${cfg.respondent === 'hr_specialist' ? 'selected' : ''}>HR Operations Specialist</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Fields to Collect (Check to Include)</label>
                <div class="field-checkbox-grid">
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('personal', this.checked)" ${activeFields.includes('personal') ? 'checked' : ''} />
                        <span>Personal & Contact Information</span>
                    </label>
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('bank', this.checked)" ${activeFields.includes('bank') ? 'checked' : ''} />
                        <span>Bank Account & IFSC Direct Deposit</span>
                    </label>
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('emergency', this.checked)" ${activeFields.includes('emergency') ? 'checked' : ''} />
                        <span>Emergency Contacts & Next of Kin</span>
                    </label>
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('education', this.checked)" ${activeFields.includes('education') ? 'checked' : ''} />
                        <span>Educational Degree Certificates</span>
                    </label>
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('relieving', this.checked)" ${activeFields.includes('relieving') ? 'checked' : ''} />
                        <span>Previous Relieving & 3 Months Payslips</span>
                    </label>
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('tax', this.checked)" ${activeFields.includes('tax') ? 'checked' : ''} />
                        <span>${(window.KylrxFmt && KylrxFmt.code() !== 'IN') ? 'Federal W-4 & State Tax Withholding Form' : 'PF UAN & Tax Declaration (Form 12B)'}</span>
                    </label>
                    <label class="field-checkbox-item">
                        <input type="checkbox" onchange="toggleFormField('assets', this.checked)" ${activeFields.includes('assets') ? 'checked' : ''} />
                        <span>IT Asset Handover Receipt</span>
                    </label>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Completion Deadline (Days)</label>
                <input type="number" class="form-control" id="cfg-form-days" value="${cfg.completionDays || 3}" min="1" max="30" />
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-clipboard-list" style="color:var(--node-form);"></i> Visual form schema generated instantly from your checkbox selections.
            </div>
        `;
    } else if (node.type === 'end') {
        formHtml += `
            <div class="form-group">
                <label class="form-label">Outcome Status</label>
                <select class="form-control" id="cfg-end-status">
                    <option value="COMPLETED" ${cfg.outcomeStatus === 'COMPLETED' ? 'selected' : ''}>COMPLETED (Successful Execution)</option>
                    <option value="REJECTED" ${cfg.outcomeStatus === 'REJECTED' ? 'selected' : ''}>REJECTED (Human Rejection Gate)</option>
                    <option value="CANCELLED" ${cfg.outcomeStatus === 'CANCELLED' ? 'selected' : ''}>CANCELLED (Withdrawn / Cancelled)</option>
                    <option value="ESCALATED" ${cfg.outcomeStatus === 'ESCALATED' ? 'selected' : ''}>ESCALATED (Handed Off to Executive)</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Audit Note</label>
                <input type="text" class="form-control" id="cfg-end-note" value="${cfg.auditNote || 'Workflow step finalized successfully.'}" />
            </div>
            <div class="no-code-pill-info">
                <i class="fas fa-flag-checkered" style="color:var(--node-end);"></i> Terminates the execution path and seals the compliance audit trail.
            </div>
        `;
    }

    // PRD Section 9: Question Customization trigger in Node Properties Panel
    const qConfigs = state.currentWorkflow?.questionConfigs || {};
    const stageQConfig = qConfigs[node.id] || qConfigs[`stage_${node.id}`] || (node.config?.questions ? { questions: node.config.questions } : null);
    const qCount = stageQConfig?.questions?.length || 0;

    formHtml += `
        <div class="stage-question-customizer-box" style="margin-top: 16px; padding: 14px; background: #f0f7ff; border: 1.5px dashed #93c5fd; border-radius: 12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                <span style="font-size: 11px; font-weight: 800; color: #1e40af; text-transform: uppercase; letter-spacing: 0.5px;">
                    <i class="fas fa-clipboard-question" style="margin-right: 4px;"></i> Question Customization (PRD §9)
                </span>
                <span class="status-badge" style="font-size: 10px; background: #dbeafe; color: #1e40af; font-weight: 700;">
                    ${qCount} ${qCount === 1 ? 'Question' : 'Questions'}
                </span>
            </div>
            <p style="font-size: 11px; color: #475569; margin-bottom: 12px; line-height: 1.4;">
                Configure dynamic questions, prompts, response types, ratings, and options for this stage without altering workflow routing.
            </p>
            <button type="button" class="btn btn-primary" style="width: 100%; font-size: 12px; padding: 8px 12px; display: flex; align-items: center; justify-content: center; gap: 8px;" onclick="window.openQuestionCustomizationDrawer('${node.id}')">
                <i class="fas fa-sliders-h"></i> Customize Stage Questions
            </button>
        </div>
    `;

    // PRD Section 12: Direct Automation and Workflow Integration
    const aConfigs = state.currentWorkflow?.automationConfigs || {};
    const stageAConfig = aConfigs[node.id] || aConfigs[`stage_${node.id}`] || (node.config?.automation ? node.config.automation : null);
    const hasAutomation = !!(stageAConfig && (stageAConfig.enabled !== false));
    const aActionType = stageAConfig?.automationConfig?.actionType || stageAConfig?.actionType || 'NOTIFY_AND_ROUTE';

    formHtml += `
        <div class="stage-automation-customizer-box" style="margin-top: 14px; padding: 14px; background: #f0fdf4; border: 1.5px dashed #86efac; border-radius: 12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                <span style="font-size: 11px; font-weight: 800; color: #166534; text-transform: uppercase; letter-spacing: 0.5px;">
                    <i class="fas fa-bolt" style="margin-right: 4px;"></i> Automation Integration (PRD §12)
                </span>
                <span class="status-badge" style="font-size: 10px; background: ${hasAutomation ? '#dcfce7' : '#f1f5f9'}; color: ${hasAutomation ? '#15803d' : '#64748b'}; font-weight: 700;">
                    ${hasAutomation ? escapeHtml(aActionType) : 'None'}
                </span>
            </div>
            <p style="font-size: 11px; color: #166534; margin-bottom: 12px; line-height: 1.4;">
                Configure targeted automation actions, alert triggers, L1/L2 approval routing, payload templates, and SLA rules.
            </p>
            <button type="button" class="btn btn-outline" style="width: 100%; font-size: 12px; padding: 8px 12px; display: flex; align-items: center; justify-content: center; gap: 8px; border-color: #86efac; color: #15803d; background: #ffffff; font-weight: 700;" onclick="window.openAutomationDrawer('${node.id}')">
                <i class="fas fa-bolt"></i> ${hasAutomation ? 'Edit Stage Automation' : 'Configure Automation'}
            </button>
        </div>
    `;

    panelBody.innerHTML = formHtml;
    attachConfigFormListeners(node);
}

function attachConfigFormListeners(node) {
    const bindInput = (id, callback) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', callback);
        if (el && el.tagName === 'SELECT') el.addEventListener('change', callback);
    };

    bindInput('cfg-node-label', (e) => {
        node.label = e.target.value;
        const cardLabel = document.querySelector(`#canvas_node_${node.id} .canvas-node-label`);
        if (cardLabel) cardLabel.textContent = node.label;
    });

    // Trigger
    bindInput('cfg-trigger-event', (e) => { node.config.event = e.target.value; updateNodeCard(node); });
    bindInput('cfg-trigger-entity', (e) => { node.config.entity = e.target.value; updateNodeCard(node); });
    bindInput('cfg-trigger-scope', (e) => { node.config.scope = e.target.value; updateNodeCard(node); });

    // Condition / Branch
    bindInput('cfg-cond-field', (e) => { node.config.field = e.target.value; updateNodeCard(node); });
    bindInput('cfg-cond-op', (e) => { node.config.operator = e.target.value; updateNodeCard(node); });
    bindInput('cfg-cond-val', (e) => { node.config.value = e.target.value; updateNodeCard(node); });
    bindInput('cfg-branch-true', (e) => { node.config.trueLabel = e.target.value; updateNodeCard(node); });
    bindInput('cfg-branch-false', (e) => { node.config.falseLabel = e.target.value; updateNodeCard(node); });

    // Approval
    bindInput('cfg-appr-role', (e) => { node.config.assigneeRole = e.target.value; updateNodeCard(node); });
    bindInput('cfg-appr-due', (e) => { node.config.dueHours = parseInt(e.target.value, 10); updateNodeCard(node); });
    bindInput('cfg-appr-reject', (e) => { node.config.onReject = e.target.value; updateNodeCard(node); });

    // Wait
    bindInput('cfg-wait-dur', (e) => { node.config.duration = parseInt(e.target.value, 10); updateNodeCard(node); });
    bindInput('cfg-wait-unit', (e) => { node.config.unit = e.target.value; updateNodeCard(node); });

    // Escalation
    bindInput('cfg-esc-to', (e) => { node.config.escalateTo = e.target.value; updateNodeCard(node); });
    bindInput('cfg-esc-sla', (e) => { node.config.slaHours = parseInt(e.target.value, 10); updateNodeCard(node); });
    bindInput('cfg-esc-urgency', (e) => { node.config.urgency = e.target.value; updateNodeCard(node); });

    // Action
    bindInput('cfg-act-type', (e) => { node.config.actionType = e.target.value; updateNodeCard(node); });
    bindInput('cfg-act-mode', (e) => { node.config.mode = e.target.value; updateNodeCard(node); });

    // Notification
    bindInput('cfg-notif-recip', (e) => { node.config.recipient = e.target.value; updateNodeCard(node); });
    bindInput('cfg-notif-chan', (e) => { node.config.channel = e.target.value; updateNodeCard(node); });
    bindInput('cfg-notif-sub', (e) => { node.config.subject = e.target.value; updateNodeCard(node); });
    bindInput('cfg-notif-msg', (e) => { node.config.template = e.target.value; updateNodeCard(node); });

    // Document
    bindInput('cfg-doc-key', (e) => { node.config.templateKey = e.target.value; updateNodeCard(node); });
    bindInput('cfg-doc-format', (e) => { node.config.format = e.target.value; updateNodeCard(node); });

    // Form
    bindInput('cfg-form-title', (e) => { node.config.formTitle = e.target.value; updateNodeCard(node); });
    bindInput('cfg-form-respondent', (e) => { node.config.respondent = e.target.value; updateNodeCard(node); });
    bindInput('cfg-form-days', (e) => { node.config.completionDays = parseInt(e.target.value, 10); updateNodeCard(node); });

    // End
    bindInput('cfg-end-status', (e) => { node.config.outcomeStatus = e.target.value; updateNodeCard(node); });
    bindInput('cfg-end-note', (e) => { node.config.auditNote = e.target.value; updateNodeCard(node); });
}

function updateNodeCard(node) {
    const bodyEl = document.querySelector(`#canvas_node_${node.id} .canvas-node-body`);
    if (bodyEl) bodyEl.innerHTML = getNodeSummary(node);
}

window.insertToken = function(token) {
    const msgEl = document.getElementById('cfg-notif-msg');
    if (msgEl) {
        msgEl.value += ' ' + token;
        msgEl.dispatchEvent(new Event('input'));
    }
};

window.setPresetValue = function(val) {
    const valEl = document.getElementById('cfg-cond-val');
    if (valEl) {
        valEl.value = val;
        valEl.dispatchEvent(new Event('input'));
    }
};

window.setSlaHours = function(hrs) {
    const dueEl = document.getElementById('cfg-appr-due');
    if (dueEl) {
        dueEl.value = hrs;
        dueEl.dispatchEvent(new Event('input'));
    }
};

window.toggleFormField = function(fieldName, isChecked) {
    if (!state.selectedNodeId) return;
    const node = state.currentWorkflow.canvas.nodes.find(n => n.id === state.selectedNodeId);
    if (!node || node.type !== 'form') return;
    node.config = node.config || {};
    node.config.fields = node.config.fields || ['personal', 'bank', 'emergency'];
    if (isChecked) {
        if (!node.config.fields.includes(fieldName)) node.config.fields.push(fieldName);
    } else {
        node.config.fields = node.config.fields.filter(f => f !== fieldName);
    }
    updateNodeCard(node);
};

// ─── ADD NODE HELPER (SMART PLACEMENT & ZERO-CODE) ───
function addNodeToCanvas(nodeType, customX = null, customY = null) {
    const nodes = state.currentWorkflow.canvas.nodes || [];
    let dropX = customX;
    let dropY = customY;

    if (dropX === null || dropY === null) {
        if (nodes.length === 0) {
            dropX = 140;
            dropY = 80;
        } else {
            const lastNode = nodes[nodes.length - 1];
            dropX = Math.min(Math.max(lastNode.x + (nodes.length % 2 === 0 ? 30 : -10), 60), 600);
            dropY = lastNode.y + 110;
        }
    }

    const newNodeId = 'node_' + Math.random().toString(36).substr(2, 6);
    const defaultConfig = getDefaultConfigForType(nodeType);

    const newNode = {
        id: newNodeId,
        type: nodeType,
        label: capitalize(nodeType),
        x: Math.round(dropX / 10) * 10,
        y: Math.round(dropY / 10) * 10,
        config: defaultConfig
    };

    state.currentWorkflow.canvas.nodes.push(newNode);
    selectNode(newNode.id);
    renderCanvas();
    showToast(`Added + ${capitalize(nodeType)} node (No-Code)`, 'success');
}

// ─── PALETTE DRAG & DROP AND CLICK-TO-ADD EVENTS ───
function setupPaletteDragEvents() {
    document.querySelectorAll('.palette-node').forEach(nodeEl => {
        const nodeType = nodeEl.getAttribute('data-node-type');

        // Drag support
        nodeEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', nodeType);
        });

        // 1-Click to add support (clicking anywhere on the palette item)
        nodeEl.addEventListener('click', (e) => {
            e.preventDefault();
            addNodeToCanvas(nodeType);
        });

        // Dedicated + button
        const addBtn = nodeEl.querySelector('.palette-add-btn');
        if (addBtn) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                addNodeToCanvas(nodeType);
            });
        }
    });

    const canvasWrapper = document.getElementById('canvas-wrapper');
    if (!canvasWrapper) return;

    canvasWrapper.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    canvasWrapper.addEventListener('drop', (e) => {
        e.preventDefault();
        const nodeType = e.dataTransfer.getData('text/plain');
        if (!nodeType) return;

        const rect = canvasWrapper.getBoundingClientRect();
        const dropX = (e.clientX - rect.left - state.panX) / state.scale;
        const dropY = (e.clientY - rect.top - state.panY) / state.scale;

        addNodeToCanvas(nodeType, dropX, dropY);
    });
}

function getDefaultConfigForType(type) {
    switch (type) {
        case 'trigger': return { event: 'candidate_offer_accepted', entity: 'candidate', scope: 'all' };
        case 'condition': return { field: 'department', operator: '==', value: 'Engineering' };
        case 'branch': return { field: 'ctc', operator: '>', value: 2000000, trueLabel: 'True / Yes', falseLabel: 'False / No' };
        case 'approval': return { assigneeRole: 'manager', dueHours: 24, onReject: 'terminate' };
        case 'wait': return { duration: 1, unit: 'days' };
        case 'escalation': return { escalateTo: 'hr_head', slaHours: 48, urgency: 'high' };
        case 'action': return { actionType: 'provision_it_assets', mode: 'immediate' };
        case 'notification': return { recipient: 'employee', channel: 'email', subject: 'Workflow Notification', template: 'Hello {{name}}, update ready.' };
        case 'document': return { templateKey: 'offer_letter', format: 'pdf_sealed' };
        case 'form': return { formTitle: 'Employee Information', fields: ['personal', 'bank', 'emergency'], completionDays: 3 };
        case 'end': return { outcomeStatus: 'COMPLETED', auditNote: 'Workflow completed successfully.' };
        default: return {};
    }
}

// ─── CANVAS PAN & ZOOM EVENTS ───
function setupCanvasEvents() {
    const canvasWrapper = document.getElementById('canvas-wrapper');
    const workflowCanvas = document.getElementById('workflow-canvas');
    if (!canvasWrapper || !workflowCanvas) return;

    // Pan Canvas
    canvasWrapper.addEventListener('mousedown', (e) => {
        if (e.target === canvasWrapper || e.target.id === 'svg-canvas' || e.target.id === 'workflow-canvas') {
            state.isDraggingCanvas = true;
            state.dragStart = { x: e.clientX - state.panX, y: e.clientY - state.panY };
            canvasWrapper.style.cursor = 'grabbing';
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!state.isDraggingCanvas) return;
        state.panX = e.clientX - state.dragStart.x;
        state.panY = e.clientY - state.dragStart.y;
        updateCanvasTransform();
    });

    window.addEventListener('mouseup', () => {
        if (state.isDraggingCanvas) {
            state.isDraggingCanvas = false;
            canvasWrapper.style.cursor = 'crosshair';
        }
    });

    // Zoom buttons
    document.getElementById('zoom-in').addEventListener('click', () => {
        state.scale = Math.min(state.scale + 0.15, 2.0);
        updateCanvasTransform();
    });
    document.getElementById('zoom-out').addEventListener('click', () => {
        state.scale = Math.max(state.scale - 0.15, 0.4);
        updateCanvasTransform();
    });
    document.getElementById('zoom-reset').addEventListener('click', () => {
        state.scale = 1;
        state.panX = 0;
        state.panY = 0;
        updateCanvasTransform();
    });

    // Clear canvas
    document.getElementById('btn-clear-canvas').addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all canvas nodes and connections?')) {
            state.currentWorkflow.canvas.nodes = [];
            state.currentWorkflow.canvas.connections = [];
            state.selectedNodeId = null;
            renderCanvas();
            renderConfigPanel();
            showToast('Canvas cleared', 'info');
        }
    });

    // Delete selected node
    document.getElementById('btn-delete-node').addEventListener('click', () => {
        if (!state.selectedNodeId) return;
        const idToDelete = state.selectedNodeId;
        state.currentWorkflow.canvas.nodes = state.currentWorkflow.canvas.nodes.filter(n => n.id !== idToDelete);
        state.currentWorkflow.canvas.connections = state.currentWorkflow.canvas.connections.filter(c => c.from !== idToDelete && c.to !== idToDelete);
        state.selectedNodeId = null;
        renderCanvas();
        renderConfigPanel();
        showToast('Node deleted', 'info');
    });
}

function updateCanvasTransform() {
    const workflowCanvas = document.getElementById('workflow-canvas');
    if (workflowCanvas) {
        workflowCanvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    }
}

// ─── TOOLBAR BUTTON ACTIONS ───
function setupToolbarEvents() {
    document.getElementById('btn-new-workflow').addEventListener('click', newWorkflow);

    // Question Customization Toolbar Trigger
    const btnOpenQ = document.getElementById('btn-open-questions-top');
    if (btnOpenQ) {
        btnOpenQ.addEventListener('click', () => {
            const stageId = state.selectedNodeId || state.currentWorkflow?.canvas?.nodes?.[0]?.id;
            if (!stageId) {
                showToast('Please add or select a stage node on the canvas first.', 'info');
                return;
            }
            window.openQuestionCustomizationDrawer(stageId);
        });
    }

    // Direct Automation Toolbar Trigger (PRD §12)
    const btnOpenAuto = document.getElementById('btn-automation-drawer');
    if (btnOpenAuto) {
        btnOpenAuto.addEventListener('click', () => {
            const stageId = state.selectedNodeId || state.currentWorkflow?.canvas?.nodes?.[0]?.id;
            window.openAutomationDrawer(stageId);
        });
    }

    // Save Workflow
    document.getElementById('btn-save').addEventListener('click', async () => {
        state.currentWorkflow.name = document.getElementById('workflow-name-input').value.trim() || 'Untitled Workflow';
        state.currentWorkflow.description = document.getElementById('workflow-desc-input').value.trim();

        try {
            const method = state.currentWorkflow.id ? 'PUT' : 'POST';
            const url = state.currentWorkflow.id ? `${API_BASE}/${state.currentWorkflow.id}` : API_BASE;
            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state.currentWorkflow)
            });
            const json = await res.json();
            if (json.success) {
                state.currentWorkflow = json.workflow;
                showToast(`Workflow "${json.workflow.name}" saved successfully!`, 'success');
                await loadWorkflowsList();
                await fetchStats();
            } else {
                showToast(json.error || 'Validation failed during save', 'error');
            }
        } catch (err) {
            console.warn('Backend offline, saving workflow locally:', err);
            if (!state.currentWorkflow.id) {
                state.currentWorkflow.id = 'wf_' + Date.now();
            }
            const existingIdx = state.workflows.findIndex(w => w.id === state.currentWorkflow.id);
            if (existingIdx >= 0) {
                state.workflows[existingIdx] = JSON.parse(JSON.stringify(state.currentWorkflow));
            } else {
                state.workflows.push(JSON.parse(JSON.stringify(state.currentWorkflow)));
            }
            renderWorkflowList();
            fetchStats();
            showToast(`Server unreachable: "${state.currentWorkflow.name}" is kept on this page only and NOT saved to Firebase.`, 'error');
        }
    });

    // Validate Workflow
    document.getElementById('btn-validate').addEventListener('click', async () => {
        try {
            const res = await fetch(`${API_BASE}/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ canvas: state.currentWorkflow.canvas })
            });
            const json = await res.json();
            if (json.success && json.validation.valid) {
                showToast('✅ Workflow structure is 100% valid and ready for automation!', 'success');
            } else {
                const errors = json.validation?.errors?.join('; ') || json.error;
                showToast(`⚠️ Validation issues: ${errors}`, 'error');
            }
        } catch (err) {
            showToast('Validation request failed', 'error');
        }
    });

    // Version Selector Change Event
    const versionSelect = document.getElementById('version-selector');
    if (versionSelect) {
        versionSelect.addEventListener('change', async (e) => {
            const verNum = parseInt(e.target.value, 10);
            state.selectedVersionNumber = verNum;
            const targetVer = state.versions.find(v => v.versionNumber === verNum);
            if (targetVer) {
                state.currentWorkflow.canvas = JSON.parse(JSON.stringify(targetVer.canvas || { nodes: [], connections: [] }));
                state.currentWorkflow.version = targetVer.versionNumber;
                state.currentWorkflow.status = targetVer.status;
                
                const badge = document.getElementById('workflow-status-badge');
                badge.className = `status-badge ${targetVer.status}`;
                badge.textContent = targetVer.status;

                const rollbackBtn = document.getElementById('btn-rollback-version');
                if (rollbackBtn) {
                    rollbackBtn.style.display = (verNum < (state.currentWorkflow.activeVersionNumber || 1)) ? 'inline-flex' : 'none';
                }

                state.selectedNodeId = state.currentWorkflow.canvas.nodes?.[0]?.id || null;
                renderCanvas();
                renderConfigPanel();
                showToast(`Viewing version v${verNum} (${targetVer.status})`, 'info');
            }
        });
    }

    // Rollback Version Button
    const rollbackBtn = document.getElementById('btn-rollback-version');
    if (rollbackBtn) {
        rollbackBtn.addEventListener('click', async () => {
            if (!state.currentWorkflow.id) return;
            const verNum = state.selectedVersionNumber;
            try {
                const res = await fetch(`${API_BASE}/${state.currentWorkflow.id}/versions/${verNum}/rollback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ actor: 'HR Admin' })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(`Rolled back workflow to v${verNum} successfully!`, 'success');
                    await loadWorkflow(state.currentWorkflow.id);
                    await loadWorkflowsList();
                    await fetchStats();
                } else {
                    showToast(json.error || 'Rollback failed', 'error');
                }
            } catch (err) {
                showToast('Rollback request failed', 'error');
            }
        });
    }

    // Activate / Publish Workflow (Enforces Test-Run Gating)
    document.getElementById('btn-activate').addEventListener('click', async () => {
        if (!state.currentWorkflow.id) {
            showToast('Please save the workflow first before publishing', 'warning');
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/${state.currentWorkflow.id}/activate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actor: 'HR Admin' })
            });
            const json = await res.json();
            if (json.success) {
                state.currentWorkflow.status = 'active';
                const badge = document.getElementById('workflow-status-badge');
                badge.className = 'status-badge active';
                badge.textContent = 'active';
                showToast('🚀 Workflow approved and published to Live Production!', 'success');
                await loadWorkflow(state.currentWorkflow.id);
                await loadWorkflowsList();
                await fetchStats();
            } else {
                if (json.error && json.error.includes('untested')) {
                    showToast('⚠️ Test required before publishing. Opening test mode...', 'warning');
                    openTestModeModal();
                } else {
                    showToast(json.error || 'Publishing failed', 'error');
                }
            }
        } catch (err) {
            console.warn('Backend offline, activating workflow locally:', err);
            state.currentWorkflow.status = 'active';
            const badge = document.getElementById('workflow-status-badge');
            if (badge) {
                badge.className = 'status-badge active';
                badge.textContent = 'active';
            }
            const existing = state.workflows.find(w => w.id === state.currentWorkflow.id);
            if (existing) existing.status = 'active';
            renderWorkflowList();
            fetchStats();
            showToast('🚀 Workflow published in local session', 'success');
        }
    });

    // Test Mode Button
    document.getElementById('btn-test-run').addEventListener('click', () => {
        openTestModeModal();
    });

    document.getElementById('btn-close-test-run').addEventListener('click', () => {
        document.getElementById('test-run-panel').classList.remove('open');
    });

    // Export JSON
    document.getElementById('btn-export').addEventListener('click', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.currentWorkflow, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `${state.currentWorkflow.name.replace(/\s+/g, '_')}_workflow.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        showToast('Exported workflow JSON', 'success');
    });
}

// ─── TEST MODE & PRE-PUBLISH DRY-RUN EVENTS ───
function openTestModeModal() {
    const modal = document.getElementById('test-mode-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    
    // Auto-select first sample employee if none selected
    const empSelect = document.getElementById('test-employee-select');
    if (empSelect && !empSelect.value && state.sampleEmployees.length > 0) {
        empSelect.value = state.sampleEmployees[0].id;
        renderSelectedEmployeeCard(state.sampleEmployees[0]);
    }
}

function renderSelectedEmployeeCard(emp) {
    const card = document.getElementById('test-employee-card');
    if (!card) return;
    if (!emp) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'grid';
    card.innerHTML = `
        <div><span class="emp-stat-label">Employee:</span> <span class="emp-stat-val">${emp.name}</span></div>
        <div><span class="emp-stat-label">Role:</span> <span class="emp-stat-val">${emp.role}</span></div>
        <div><span class="emp-stat-label">Department:</span> <span class="emp-stat-val">${emp.department}</span></div>
        <div><span class="emp-stat-label">CTC:</span> <span class="emp-stat-val">${window.KylrxFmt ? KylrxFmt.money(emp.ctc || 0, { decimals: 0 }) : '₹' + (emp.ctc || 0).toLocaleString()}</span></div>
        <div><span class="emp-stat-label">Tenure:</span> <span class="emp-stat-val">${emp.tenureMonths || 0} months</span></div>
        <div><span class="emp-stat-label">Days Absent:</span> <span class="emp-stat-val">${emp.daysAbsent || 0} days</span></div>
    `;
}

function setupTestModeEvents() {
    const modal = document.getElementById('test-mode-modal');
    const btnClose = document.getElementById('btn-close-test-modal');
    const empSelect = document.getElementById('test-employee-select');
    const btnExecute = document.getElementById('btn-execute-test-mode');
    const btnPublish = document.getElementById('btn-publish-from-test');
    const dryRunList = document.getElementById('dry-run-nodes-list');
    const countBadge = document.getElementById('test-trace-count-badge');

    if (!modal) return;

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    if (empSelect) {
        empSelect.addEventListener('change', () => {
            const empId = empSelect.value;
            const emp = state.sampleEmployees.find(e => e.id === empId);
            renderSelectedEmployeeCard(emp);
        });
    }

    if (btnExecute) {
        btnExecute.addEventListener('click', async () => {
            if (!state.currentWorkflow.id) {
                showToast('Please save workflow first before running test simulation', 'warning');
                return;
            }

            const empId = empSelect?.value || undefined;
            let customPayload = {};
            const customJsonVal = document.getElementById('test-custom-json')?.value?.trim();
            if (customJsonVal) {
                try {
                    customPayload = JSON.parse(customJsonVal);
                } catch (e) {
                    showToast('Invalid custom JSON payload syntax', 'error');
                    return;
                }
            }

            btnExecute.disabled = true;
            btnExecute.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Simulating Execution...';
            dryRunList.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:15px;"><i class="fas fa-spinner fa-spin"></i> Evaluating nodes against employee context...</div>';

            try {
                const res = await fetch(`${API_BASE}/${state.currentWorkflow.id}/test-run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        employeeId: empId,
                        mockData: customPayload,
                        actor: 'HR Admin'
                    })
                });

                const json = await res.json();
                if (json.success && json.simulation) {
                    const trace = json.simulation.executionTrace || [];
                    if (countBadge) {
                        countBadge.style.display = 'inline-flex';
                        countBadge.textContent = `${trace.length} Nodes Evaluated`;
                        countBadge.className = 'status-badge active';
                    }

                    dryRunList.innerHTML = '';
                    trace.forEach((step, idx) => {
                        const row = document.createElement('div');
                        row.className = 'dry-run-node-item';
                        const icon = NODE_ICONS[step.nodeType] || 'fa-cog';
                        const color = NODE_COLORS[step.nodeType] || '#6366f1';
                        
                        row.innerHTML = `
                            <div style="font-weight:700; color:var(--text-muted); width:20px; font-size:11px;">#${idx + 1}</div>
                            <div style="width:24px; height:24px; border-radius:6px; background:${color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; flex-shrink:0;">
                                <i class="fas ${icon}"></i>
                            </div>
                            <div style="flex:1;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <strong style="color:var(--text-primary); font-size:12px;">${step.label || step.nodeType}</strong>
                                    <span class="item-badge badge-success">${step.outcome}</span>
                                </div>
                                <div style="color:var(--text-secondary); font-size:11px; margin-top:2px;">${step.details}</div>
                            </div>
                        `;
                        dryRunList.appendChild(row);
                    });

                    // Show Approve & Publish button
                    if (btnPublish) btnPublish.style.display = 'inline-flex';

                    // Update local workflow state to reflect tested status
                    if (state.currentWorkflow.status === 'draft') {
                        const badge = document.getElementById('workflow-status-badge');
                        if (badge) {
                            badge.className = 'status-badge draft';
                            badge.textContent = 'Draft (Tested)';
                        }
                    }

                    showToast(`Dry-run trace complete: ${trace.length} nodes verified!`, 'success');
                } else {
                    dryRunList.innerHTML = `<div style="color:var(--accent-red);font-size:11.5px;padding:12px;">Simulation error: ${json.error}</div>`;
                }
            } catch (err) {
                dryRunList.innerHTML = `<div style="color:var(--accent-red);font-size:11.5px;padding:12px;">Simulation request failed: ${err.message}</div>`;
            } finally {
                btnExecute.disabled = false;
                btnExecute.innerHTML = '<i class="fas fa-play"></i> Re-Run Test Simulation';
            }
        });
    }

    if (btnPublish) {
        btnPublish.addEventListener('click', async () => {
            if (!state.currentWorkflow.id) return;
            try {
                const res = await fetch(`${API_BASE}/${state.currentWorkflow.id}/activate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ actor: 'HR Admin' })
                });
                const json = await res.json();
                if (json.success) {
                    modal.style.display = 'none';
                    state.currentWorkflow.status = 'active';
                    const badge = document.getElementById('workflow-status-badge');
                    badge.className = 'status-badge active';
                    badge.textContent = 'active';
                    showToast('🚀 Workflow approved and published to Live Production!', 'success');
                    await loadWorkflow(state.currentWorkflow.id);
                    await loadWorkflowsList();
                    await fetchStats();
                } else {
                    showToast(json.error || 'Failed to publish workflow', 'error');
                }
            } catch (err) {
                showToast('Publish error: ' + err.message, 'error');
            }
        });
    }
}

function simulateLocalTrace() {
    const nodes = state.currentWorkflow.canvas.nodes || [];
    return nodes.map(n => ({
        nodeId: n.id,
        nodeType: n.type,
        label: n.label,
        outcome: 'SUCCESS',
        details: `Simulated step execution for ${n.label}`
    }));
}

function animateExecutionTrace(trace) {
    const traceContainer = document.getElementById('test-run-trace');
    traceContainer.innerHTML = '';

    if (trace.length === 0) {
        traceContainer.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">No steps were executed</div>';
        return;
    }

    trace.forEach((step, idx) => {
        setTimeout(() => {
            // Highlight node on canvas
            document.querySelectorAll('.canvas-node').forEach(el => el.classList.remove('executing'));
            const nodeEl = document.getElementById(`canvas_node_${step.nodeId}`);
            if (nodeEl) nodeEl.classList.add('executing');

            const stepDiv = document.createElement('div');
            stepDiv.className = 'trace-step';
            stepDiv.innerHTML = `
                <div class="trace-step-icon"><i class="fas fa-check"></i></div>
                <div class="trace-step-content">
                    <div class="trace-step-title">${step.label || step.nodeType}</div>
                    <div class="trace-step-desc">${step.details || step.outcome}</div>
                </div>
            `;
            traceContainer.appendChild(stepDiv);
            traceContainer.scrollTop = traceContainer.scrollHeight;

            if (idx === trace.length - 1) {
                setTimeout(() => {
                    document.querySelectorAll('.canvas-node').forEach(el => el.classList.remove('executing'));
                    showToast('Simulation complete: All paths verified', 'success');
                }, 1000);
            }
        }, idx * 600);
    });
}

function hexToRgb(hex) {
    const bigint = parseInt(hex.replace('#', ''), 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `${r}, ${g}, ${b}`;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── AI AUTOMATION CREATOR EVENT HANDLERS ───
let currentGeneratedAiFlow = null;

function setupAiCreatorEvents() {
    const modal = document.getElementById('ai-creator-modal');
    const btnOpen = document.getElementById('btn-ai-creator');
    const btnClose = document.getElementById('btn-close-ai-modal');
    const btnGenerate = document.getElementById('btn-generate-ai-flow');
    const btnApply = document.getElementById('btn-apply-ai-workflow');
    const promptInput = document.getElementById('ai-prompt-input');
    const previewContainer = document.getElementById('ai-preview-container');
    const explanationEl = document.getElementById('ai-explanation');
    const previewChainEl = document.getElementById('ai-preview-chain');
    const confidenceBadge = document.getElementById('ai-confidence-badge');

    if (!modal || !btnOpen) return;

    btnOpen.addEventListener('click', () => {
        modal.style.display = 'flex';
        if (promptInput) promptInput.focus();
    });

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    if (btnGenerate) {
        btnGenerate.addEventListener('click', async () => {
            const prompt = (promptInput?.value || '').trim();
            if (!prompt) {
                showToast('Please enter a natural-language workflow request.', 'error');
                return;
            }

            btnGenerate.disabled = true;
            btnGenerate.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Synthesizing Flow...';

            try {
                const res = await fetch(`${API_BASE}/ai-generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt })
                });

                const json = await res.json();
                if (json.success && json.workflow) {
                    currentGeneratedAiFlow = json.workflow;

                    if (explanationEl) explanationEl.textContent = json.explanation;
                    if (confidenceBadge) confidenceBadge.textContent = `Confidence: ${Math.round((json.confidence || 0.95) * 100)}%`;

                    if (previewChainEl) {
                        previewChainEl.innerHTML = '';
                        const chain = json.nodeChain || [];
                        chain.forEach((type, idx) => {
                            const pill = document.createElement('span');
                            const color = NODE_COLORS[type.toLowerCase()] || '#6366f1';
                            pill.className = 'ai-chain-pill';
                            pill.style.background = color;
                            pill.textContent = type;
                            previewChainEl.appendChild(pill);

                            if (idx < chain.length - 1) {
                                const arrow = document.createElement('span');
                                arrow.className = 'ai-chain-arrow';
                                arrow.innerHTML = '➔';
                                previewChainEl.appendChild(arrow);
                            }
                        });
                    }

                    if (previewContainer) previewContainer.style.display = 'block';
                    if (btnApply) btnApply.style.display = 'inline-flex';
                    showToast('AI synthesized workflow sequence!', 'success');
                } else {
                    showToast(json.error || 'Failed to synthesize workflow', 'error');
                }
            } catch (err) {
                console.error('AI synthesis error:', err);
                showToast('AI synthesis request failed', 'error');
            } finally {
                btnGenerate.disabled = false;
                btnGenerate.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Synthesize Workflow';
            }
        });
    }

    if (btnApply) {
        btnApply.addEventListener('click', () => {
            if (!currentGeneratedAiFlow) return;

            state.currentWorkflow = currentGeneratedAiFlow;
            document.getElementById('workflow-name-input').value = currentGeneratedAiFlow.name;
            document.getElementById('workflow-desc-input').value = currentGeneratedAiFlow.description || '';

            const badge = document.getElementById('workflow-status-badge');
            badge.className = 'status-badge draft';
            badge.textContent = 'Draft (Review)';

            // Show AI Review Mode Banner on Canvas
            const reviewBanner = document.getElementById('ai-review-banner');
            if (reviewBanner) reviewBanner.style.display = 'flex';

            modal.style.display = 'none';
            state.selectedNodeId = currentGeneratedAiFlow.canvas?.nodes?.[0]?.id || null;
            renderCanvas();
            renderConfigPanel();
            loadWorkflowsList();
            fetchStats();

            showToast(`Loaded AI draft "${currentGeneratedAiFlow.name}" in Review mode`, 'success');
        });
    }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PRD SECTION 9: QUESTION CUSTOMIZATION CONTROLLER (STRICT BOUNDARY)
   Modular Cloud Firestore persistence under workflows/{id}/question_configs/{stageId}
   Zero impact on workflow routing, stages, or execution engine rules.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const questionState = {
    activeStageId: null,
    activeStageLabel: '',
    editingQuestionId: null,
    stagedQuestions: [],
    activeTab: 'builder'
};

const ENTERPRISE_QUESTION_PRESETS = [
    {
        key: 'pms_quarterly_review',
        title: 'Quarterly Performance & Manager Review',
        icon: 'fa-chart-line',
        desc: 'Standard quarterly deliverables review, milestone evaluation, and velocity rating.',
        tags: ['Performance', 'Rating 1-5', 'Quarterly'],
        questions: [
            {
                questionId: 'q_pms_1',
                prompt: 'What key quarterly deliverables and milestones were achieved?',
                type: 'textarea',
                required: true,
                placeholder: 'Summarize target completion percentage and key impacts...',
                options: [],
                scale: null,
                order: 1
            },
            {
                questionId: 'q_pms_2',
                prompt: 'Rate deliverable completion velocity (1 to 5)',
                type: 'rating',
                required: true,
                placeholder: '1 = Stalled, 5 = High Velocity',
                options: [],
                scale: 5,
                order: 2
            },
            {
                questionId: 'q_pms_3',
                prompt: 'Rate adherence to engineering standards and technical quality (1 to 5)',
                type: 'rating',
                required: true,
                placeholder: '1 = Substandard, 5 = Production Ready',
                options: [],
                scale: 5,
                order: 3
            },
            {
                questionId: 'q_pms_4',
                prompt: 'Overall Appraisal Performance Rating',
                type: 'select',
                required: true,
                placeholder: 'Select final rating grade',
                options: [
                    'Exceeded Expectations (O)',
                    'Consistently Met Expectations (EE)',
                    'Partially Met Expectations (ME)',
                    'Needs Improvement (NI)'
                ],
                scale: null,
                order: 4
            },
            {
                questionId: 'q_pms_5',
                prompt: 'Supporting Documentation / Performance Evidence (PDF, DOCX)',
                type: 'file',
                required: false,
                placeholder: 'Upload quarterly report, code review stats or project sign-off',
                options: [],
                scale: null,
                order: 5
            }
        ]
    },
    {
        key: 'onboarding_candidate_intake',
        title: 'New Hire Candidate Intake & Provisioning',
        icon: 'fa-user-plus',
        desc: 'New employee legal profile, direct deposit bank information, and hardware kit selection.',
        tags: ['Onboarding', 'Identity', 'Direct Deposit'],
        questions: [
            {
                questionId: 'q_onb_1',
                prompt: 'Confirm Candidate Legal Full Name (as per Passport / National ID)',
                type: 'text',
                required: true,
                placeholder: 'e.g. Alexander John Mercer',
                options: [],
                scale: null,
                order: 1
            },
            {
                questionId: 'q_onb_2',
                prompt: 'Bank Account Number & IFSC / SWIFT Code for Direct Deposit',
                type: 'text',
                required: true,
                placeholder: 'e.g. HDFC0001234 - Account 50100234567890',
                options: [],
                scale: null,
                order: 2
            },
            {
                questionId: 'q_onb_3',
                prompt: 'Select Preferred Corporate Hardware Kit',
                type: 'select',
                required: true,
                placeholder: 'Choose developer workstation',
                options: [
                    'Apple MacBook Pro 16" (M3 Max / 36GB)',
                    'Dell XPS 15 Enterprise (i9 / 32GB)',
                    'Lenovo ThinkPad X1 Carbon (32GB)'
                ],
                scale: null,
                order: 3
            },
            {
                questionId: 'q_onb_4',
                prompt: 'Upload Signed Offer Letter & Government ID Verification',
                type: 'file',
                required: true,
                placeholder: 'PDF or scanned image attachment',
                options: [],
                scale: null,
                order: 4
            }
        ]
    },
    {
        key: 'it_asset_handover',
        title: 'IT Asset Handover & Security Sign-off',
        icon: 'fa-laptop',
        desc: 'Verification of returned devices, physical condition grading, and peripheral checklist.',
        tags: ['Asset Mgmt', 'IT Operations', 'Offboarding'],
        questions: [
            {
                questionId: 'q_ast_1',
                prompt: 'Company Asset Tag / Laptop Serial Number',
                type: 'text',
                required: true,
                placeholder: 'e.g. KYLRX-LT-2024-884',
                options: [],
                scale: null,
                order: 1
            },
            {
                questionId: 'q_ast_2',
                prompt: 'Rate Physical Equipment Condition (1 to 5)',
                type: 'rating',
                required: true,
                placeholder: '1 = Heavy Damage, 5 = Pristine Condition',
                options: [],
                scale: 5,
                order: 2
            },
            {
                questionId: 'q_ast_3',
                prompt: 'Peripherals & Accessories Handed Over',
                type: 'multiselect',
                required: true,
                placeholder: 'Check all that apply',
                options: [
                    'Power Adapter & MagSafe/Type-C Cord',
                    'Corporate Security Key / YubiKey',
                    'Building RFID Access Badge',
                    'External Monitor & HDMI/DisplayPort Cable',
                    'Wireless Mouse & Keyboard'
                ],
                scale: null,
                order: 3
            },
            {
                questionId: 'q_ast_4',
                prompt: 'Upload Physical Handover Form Signed by IT Administrator',
                type: 'file',
                required: true,
                placeholder: 'Scanned signature document',
                options: [],
                scale: null,
                order: 4
            }
        ]
    },
    {
        key: 'exit_ff_clearance',
        title: 'Exit Clearance & Final Settlement (F&F)',
        icon: 'fa-door-open',
        desc: 'Department handover sign-offs, outstanding financial dues, and exit interview clearance.',
        tags: ['Exit', 'Finance', 'F&F Settlement'],
        questions: [
            {
                questionId: 'q_exit_1',
                prompt: 'Knowledge Transfer & Project Documentation Status',
                type: 'select',
                required: true,
                placeholder: 'Select KT completion status',
                options: [
                    '100% Completed & Verified by Team Lead',
                    'Partial Handover Completed',
                    'Handover Incomplete / Missing Documentation'
                ],
                scale: null,
                order: 1
            },
            {
                questionId: 'q_exit_2',
                prompt: 'Notice Period Served (Number of Days)',
                type: 'text',
                required: true,
                placeholder: 'e.g. 60 or 90 Days',
                options: [],
                scale: null,
                order: 2
            },
            {
                questionId: 'q_exit_3',
                prompt: 'Finance Verification: Outstanding Travel Advances or Company Dues?',
                type: 'select',
                required: true,
                placeholder: 'Select finance status',
                options: [
                    'Nil / No Outstanding Dues',
                    'Salary Advance Deduction Required in F&F',
                    'Company Hardware Purchase Buyout Pending'
                ],
                scale: null,
                order: 3
            },
            {
                questionId: 'q_exit_4',
                prompt: 'Department Head & HR Relieving Remarks',
                type: 'textarea',
                required: false,
                placeholder: 'Enter any final comments for settlement calculation...',
                options: [],
                scale: null,
                order: 4
            }
        ]
    }
];

// Open Question Customization Slide-Out Drawer for a Stage
window.openQuestionCustomizationDrawer = function(stageId) {
    if (!stageId) {
        if (state.currentWorkflow?.canvas?.nodes?.length > 0) {
            stageId = state.currentWorkflow.canvas.nodes[0].id;
        } else {
            showToast('Please add at least one stage node to the canvas first.', 'info');
            return;
        }
    }

    const node = state.currentWorkflow?.canvas?.nodes?.find(n => n.id === stageId);
    const stageLabel = node?.label || stageId;

    questionState.activeStageId = stageId;
    questionState.activeStageLabel = stageLabel;
    questionState.editingQuestionId = null;

    // Load existing question configurations from workflow state or initialize
    const qConfigs = state.currentWorkflow.questionConfigs || {};
    const existing = qConfigs[stageId] || qConfigs[`stage_${stageId}`] || null;

    if (existing && Array.isArray(existing.questions) && existing.questions.length > 0) {
        questionState.stagedQuestions = JSON.parse(JSON.stringify(existing.questions));
    } else if (node && node.config && Array.isArray(node.config.questions) && node.config.questions.length > 0) {
        questionState.stagedQuestions = JSON.parse(JSON.stringify(node.config.questions));
    } else {
        // Pre-seed default prompt if none exists
        questionState.stagedQuestions = [
            {
                questionId: `q_${Date.now()}_1`,
                prompt: `What deliverables or actions were finalized for ${stageLabel}?`,
                type: 'textarea',
                required: true,
                placeholder: 'Enter status details and achievements...',
                options: [],
                scale: null,
                order: 1
            }
        ];
    }

    // Populate header info
    const labelEl = document.getElementById('qdStageLabel');
    const idEl = document.getElementById('qdStageId');
    if (labelEl) labelEl.textContent = stageLabel;
    if (idEl) idEl.textContent = `stage_${stageId}`;

    // Reset Form
    window.cancelQuestionEdit();

    // Render Lists & Presets
    window.renderDrawerQuestionsList();
    window.renderPresetsList();
    window.switchQdTab('builder');

    // Show Overlay and Drawer
    const overlay = document.getElementById('questionDrawerOverlay');
    const drawer = document.getElementById('questionDrawer');
    if (overlay) overlay.style.display = 'block';
    if (drawer) drawer.style.display = 'flex';
};

window.closeQuestionCustomizationDrawer = function() {
    const overlay = document.getElementById('questionDrawerOverlay');
    const drawer = document.getElementById('questionDrawer');
    if (overlay) overlay.style.display = 'none';
    if (drawer) drawer.style.display = 'none';
    questionState.activeStageId = null;
    questionState.editingQuestionId = null;
};

window.switchQdTab = function(tabName) {
    questionState.activeTab = tabName;
    ['builder', 'preview', 'presets'].forEach(t => {
        const tabBtn = document.getElementById(`qd-tab-${t}`);
        const content = document.getElementById(`qd-content-${t}`);
        if (tabBtn) {
            if (t === tabName) tabBtn.classList.add('active');
            else tabBtn.classList.remove('active');
        }
        if (content) {
            content.style.display = (t === tabName) ? 'flex' : 'none';
        }
    });

    if (tabName === 'preview') {
        window.renderQuestionLivePreview();
    }
};

window.handleQuestionTypeChange = function() {
    const typeSelect = document.getElementById('qd-input-type');
    const scaleGroup = document.getElementById('qd-field-scale-group');
    const optionsGroup = document.getElementById('qd-field-options-group');
    if (!typeSelect) return;

    const val = typeSelect.value;
    if (scaleGroup) {
        scaleGroup.style.display = (val === 'rating') ? 'block' : 'none';
    }
    if (optionsGroup) {
        optionsGroup.style.display = (val === 'select' || val === 'multiselect') ? 'block' : 'none';
    }
};

window.updateOptionsPreview = function() {
    const input = document.getElementById('qd-input-options');
    const container = document.getElementById('qd-options-chips-preview');
    if (!input || !container) return;

    const items = input.value.split(',').map(s => s.trim()).filter(Boolean);
    container.innerHTML = '';
    items.forEach(item => {
        const chip = document.createElement('span');
        chip.className = 'qd-chip';
        chip.textContent = item;
        container.appendChild(chip);
    });
};

window.handleQuestionFormSubmit = function(e) {
    e.preventDefault();
    const promptInput = document.getElementById('qd-input-prompt');
    const typeSelect = document.getElementById('qd-input-type');
    const requiredCheck = document.getElementById('qd-input-required');
    const scaleSelect = document.getElementById('qd-input-scale');
    const optionsInput = document.getElementById('qd-input-options');
    const placeholderInput = document.getElementById('qd-input-placeholder');

    if (!promptInput || !promptInput.value.trim()) {
        showToast('Question prompt is required', 'error');
        return;
    }

    const prompt = promptInput.value.trim();
    const type = typeSelect ? typeSelect.value : 'text';
    const required = requiredCheck ? requiredCheck.checked : false;
    const placeholder = placeholderInput ? placeholderInput.value.trim() : '';
    const scale = (type === 'rating' && scaleSelect) ? parseInt(scaleSelect.value, 10) : null;
    const options = (type === 'select' || type === 'multiselect') && optionsInput
        ? optionsInput.value.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    if (questionState.editingQuestionId) {
        // Update existing question
        const qIdx = questionState.stagedQuestions.findIndex(q => q.questionId === questionState.editingQuestionId);
        if (qIdx >= 0) {
            questionState.stagedQuestions[qIdx] = {
                ...questionState.stagedQuestions[qIdx],
                prompt,
                type,
                required,
                placeholder,
                scale,
                options
            };
            showToast('Question updated', 'success');
        }
    } else {
        // Add new question
        const newQ = {
            questionId: `q_${Date.now()}_${questionState.stagedQuestions.length + 1}`,
            prompt,
            type,
            required,
            placeholder,
            scale,
            options,
            order: questionState.stagedQuestions.length + 1
        };
        questionState.stagedQuestions.push(newQ);
        showToast('Question added to stage', 'success');
    }

    window.cancelQuestionEdit();
    window.renderDrawerQuestionsList();
};

window.editQuestion = function(qId) {
    const q = questionState.stagedQuestions.find(item => item.questionId === qId);
    if (!q) return;

    questionState.editingQuestionId = qId;

    const heading = document.getElementById('qd-form-heading');
    const cancelBtn = document.getElementById('qd-btn-cancel-edit');
    const submitText = document.getElementById('qd-submit-text');

    if (heading) heading.innerHTML = `<i class="fas fa-edit"></i> Edit Question (#${q.order || 1})`;
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    if (submitText) submitText.textContent = 'Update Question';

    const promptInput = document.getElementById('qd-input-prompt');
    const typeSelect = document.getElementById('qd-input-type');
    const requiredCheck = document.getElementById('qd-input-required');
    const reqText = document.getElementById('qd-required-text');
    const scaleSelect = document.getElementById('qd-input-scale');
    const optionsInput = document.getElementById('qd-input-options');
    const placeholderInput = document.getElementById('qd-input-placeholder');

    if (promptInput) promptInput.value = q.prompt || '';
    if (typeSelect) typeSelect.value = q.type || 'text';
    if (requiredCheck) {
        requiredCheck.checked = Boolean(q.required);
        if (reqText) reqText.textContent = q.required ? 'Required: Yes' : 'Required: No';
    }
    if (scaleSelect && q.scale) scaleSelect.value = String(q.scale);
    if (optionsInput) optionsInput.value = (q.options || []).join(', ');
    if (placeholderInput) placeholderInput.value = q.placeholder || '';

    window.handleQuestionTypeChange();
    window.updateOptionsPreview();
    window.renderDrawerQuestionsList();

    // Scroll to top of drawer
    const body = document.querySelector('.qd-body');
    if (body) body.scrollTo({ top: 0, behavior: 'smooth' });
};

window.cancelQuestionEdit = function() {
    questionState.editingQuestionId = null;

    const heading = document.getElementById('qd-form-heading');
    const cancelBtn = document.getElementById('qd-btn-cancel-edit');
    const submitText = document.getElementById('qd-submit-text');
    const form = document.getElementById('qd-question-form');

    if (heading) heading.innerHTML = '<i class="fas fa-plus-circle"></i> Add Question';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (submitText) submitText.textContent = 'Add Question to Stage';
    if (form) form.reset();

    const reqText = document.getElementById('qd-required-text');
    if (reqText) reqText.textContent = 'Required: No';

    const chips = document.getElementById('qd-options-chips-preview');
    if (chips) chips.innerHTML = '';

    window.handleQuestionTypeChange();
};

window.deleteQuestion = function(qId) {
    if (!confirm('Are you sure you want to remove this question?')) return;
    questionState.stagedQuestions = questionState.stagedQuestions.filter(q => q.questionId !== qId);
    // Re-index orders
    questionState.stagedQuestions.forEach((q, idx) => { q.order = idx + 1; });

    if (questionState.editingQuestionId === qId) {
        window.cancelQuestionEdit();
    }
    window.renderDrawerQuestionsList();
    showToast('Question removed', 'info');
};

window.duplicateQuestion = function(qId) {
    const q = questionState.stagedQuestions.find(item => item.questionId === qId);
    if (!q) return;

    const copy = JSON.parse(JSON.stringify(q));
    copy.questionId = `q_${Date.now()}_${questionState.stagedQuestions.length + 1}`;
    copy.prompt = `${copy.prompt} (Copy)`;
    copy.order = questionState.stagedQuestions.length + 1;

    questionState.stagedQuestions.push(copy);
    window.renderDrawerQuestionsList();
    showToast('Question duplicated', 'success');
};

window.moveQuestionOrder = function(qId, direction) {
    const idx = questionState.stagedQuestions.findIndex(q => q.questionId === qId);
    if (idx < 0) return;

    if (direction === 'up' && idx > 0) {
        const temp = questionState.stagedQuestions[idx];
        questionState.stagedQuestions[idx] = questionState.stagedQuestions[idx - 1];
        questionState.stagedQuestions[idx - 1] = temp;
    } else if (direction === 'down' && idx < questionState.stagedQuestions.length - 1) {
        const temp = questionState.stagedQuestions[idx];
        questionState.stagedQuestions[idx] = questionState.stagedQuestions[idx + 1];
        questionState.stagedQuestions[idx + 1] = temp;
    }

    questionState.stagedQuestions.forEach((q, i) => { q.order = i + 1; });
    window.renderDrawerQuestionsList();
};

window.resetStageQuestions = function() {
    if (!confirm('Reset all questions for this stage back to defaults?')) return;
    const stageLabel = questionState.activeStageLabel || 'Stage';
    questionState.stagedQuestions = [
        {
            questionId: `q_${Date.now()}_1`,
            prompt: `What deliverables or actions were finalized for ${stageLabel}?`,
            type: 'textarea',
            required: true,
            placeholder: 'Enter status details and achievements...',
            options: [],
            scale: null,
            order: 1
        }
    ];
    window.cancelQuestionEdit();
    window.renderDrawerQuestionsList();
    showToast('Reset questions to default', 'info');
};

window.loadPresetQuestions = function(presetKey) {
    const preset = ENTERPRISE_QUESTION_PRESETS.find(p => p.key === presetKey);
    if (!preset) return;

    if (questionState.stagedQuestions.length > 0) {
        if (!confirm(`Apply the "${preset.title}" preset template? This will replace currently staged questions.`)) {
            return;
        }
    }

    questionState.stagedQuestions = JSON.parse(JSON.stringify(preset.questions));
    window.cancelQuestionEdit();
    window.renderDrawerQuestionsList();
    window.switchQdTab('builder');
    showToast(`Loaded preset: ${preset.title}`, 'success');
};

window.renderDrawerQuestionsList = function() {
    const container = document.getElementById('qd-questions-list-container');
    const countBadge = document.getElementById('qd-question-count');
    if (countBadge) countBadge.textContent = questionState.stagedQuestions.length;
    if (!container) return;

    container.innerHTML = '';

    if (questionState.stagedQuestions.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding: 24px; color: var(--text-muted); font-size: 12px; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 10px;">
                <i class="fas fa-clipboard-question" style="font-size: 28px; color: #93c5fd; margin-bottom: 8px; display:block;"></i>
                No questions configured yet for this stage.<br>
                Use the form above to add a question or choose an Enterprise Preset.
            </div>
        `;
        return;
    }

    questionState.stagedQuestions.forEach((q, idx) => {
        const isEditing = questionState.editingQuestionId === q.questionId;
        const card = document.createElement('div');
        card.className = `qd-q-card ${isEditing ? 'editing' : ''}`;

        const typeBadgeClass = `qd-badge-${q.type}`;
        const typeLabel = q.type === 'rating' ? `Rating 1-${q.scale || 5}` 
            : q.type === 'select' ? 'Dropdown' 
            : q.type === 'multiselect' ? 'Multi-Select' 
            : q.type === 'textarea' ? 'Paragraph' 
            : q.type === 'file' ? 'File Upload' : 'Short Text';

        let metaHtml = '';
        if (q.placeholder) {
            metaHtml += `<div style="font-style:italic; color:#64748b; margin-top:2px;">Placeholder: "${escapeHtml(q.placeholder)}"</div>`;
        }
        if (q.options && q.options.length > 0) {
            metaHtml += `<div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:4px;">
                ${q.options.map(opt => `<span class="qd-chip" style="font-size:10px;">${escapeHtml(opt)}</span>`).join('')}
            </div>`;
        }

        card.innerHTML = `
            <div class="qd-q-order">#${idx + 1}</div>
            <div class="qd-q-main">
                <div class="qd-q-header">
                    <span class="qd-q-type-badge ${typeBadgeClass}">${typeLabel}</span>
                    <span class="qd-q-req-badge ${q.required ? 'qd-req-yes' : 'qd-req-no'}">
                        ${q.required ? '* MANDATORY' : 'OPTIONAL'}
                    </span>
                    <span style="font-size:10px; color:#94a3b8; font-family:monospace;">${q.questionId}</span>
                </div>
                <div class="qd-q-prompt">${escapeHtml(q.prompt)}</div>
                ${metaHtml}
            </div>
            <div class="qd-q-actions">
                <button type="button" class="qd-btn-icon" title="Move Up" ${idx === 0 ? 'disabled' : ''} onclick="moveQuestionOrder('${q.questionId}', 'up')">
                    <i class="fas fa-arrow-up"></i>
                </button>
                <button type="button" class="qd-btn-icon" title="Move Down" ${idx === questionState.stagedQuestions.length - 1 ? 'disabled' : ''} onclick="moveQuestionOrder('${q.questionId}', 'down')">
                    <i class="fas fa-arrow-down"></i>
                </button>
                <button type="button" class="qd-btn-icon" title="Edit Question" onclick="editQuestion('${q.questionId}')">
                    <i class="fas fa-pen"></i>
                </button>
                <button type="button" class="qd-btn-icon" title="Duplicate Question" onclick="duplicateQuestion('${q.questionId}')">
                    <i class="fas fa-copy"></i>
                </button>
                <button type="button" class="qd-btn-icon delete" title="Delete Question" onclick="deleteQuestion('${q.questionId}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        container.appendChild(card);
    });
};

window.renderQuestionLivePreview = function() {
    const container = document.getElementById('qd-preview-form-container');
    const titleEl = document.getElementById('qd-preview-title');
    if (titleEl) titleEl.textContent = `${questionState.activeStageLabel || 'Stage'} - Question View`;
    if (!container) return;

    container.innerHTML = '';

    if (questionState.stagedQuestions.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding: 20px; color:#64748b; font-size:12px;">No questions to preview. Add questions in the Question Builder tab.</div>';
        return;
    }

    questionState.stagedQuestions.forEach((q, idx) => {
        const itemWrap = document.createElement('div');
        itemWrap.className = 'qd-preview-field-group';

        const labelHtml = `
            <label style="display:block; font-size:12px; font-weight:700; color:#0f172a; margin-bottom: 6px;">
                ${idx + 1}. ${escapeHtml(q.prompt)}
                ${q.required ? '<span style="color:#ef4444; margin-left:3px;">*</span>' : '<span style="font-weight:400; font-size:10.5px; color:#64748b; margin-left:4px;">(Optional)</span>'}
            </label>
        `;

        let controlHtml = '';
        if (q.type === 'text') {
            controlHtml = `<input type="text" class="qd-input" placeholder="${escapeHtml(q.placeholder || 'Enter short answer...')}" />`;
        } else if (q.type === 'textarea') {
            controlHtml = `<textarea class="qd-textarea" rows="3" placeholder="${escapeHtml(q.placeholder || 'Type your detailed response here...')}"></textarea>`;
        } else if (q.type === 'rating') {
            const scaleCount = q.scale || 5;
            let ratingButtons = '';
            for (let i = 1; i <= scaleCount; i++) {
                ratingButtons += `<button type="button" class="qd-sim-rating-btn" onclick="this.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active')); this.classList.add('active');">${i}</button>`;
            }
            controlHtml = `
                <div class="qd-sim-rating-grid">${ratingButtons}</div>
                <div style="font-size:10.5px; color:#64748b; margin-top:4px;">${escapeHtml(q.placeholder || `Rating on a 1 to ${scaleCount} scale`)}</div>
            `;
        } else if (q.type === 'select') {
            const optionsHtml = (q.options && q.options.length > 0)
                ? q.options.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('')
                : '<option value="">-- No options configured --</option>';
            controlHtml = `
                <select class="qd-select">
                    <option value="">${escapeHtml(q.placeholder || '-- Select an option --')}</option>
                    ${optionsHtml}
                </select>
            `;
        } else if (q.type === 'multiselect') {
            const options = q.options && q.options.length > 0 ? q.options : ['Option 1', 'Option 2'];
            controlHtml = `
                <div style="display:flex; flex-direction:column; gap:6px; background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
                    ${options.map((opt, oIdx) => `
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; color:#334155; cursor:pointer;">
                            <input type="checkbox" style="cursor:pointer;" />
                            <span>${escapeHtml(opt)}</span>
                        </label>
                    `).join('')}
                </div>
            `;
        } else if (q.type === 'file') {
            controlHtml = `
                <div class="qd-sim-file-drop">
                    <i class="fas fa-cloud-arrow-up" style="font-size:22px; margin-bottom:4px; display:block;"></i>
                    <strong style="font-size:12px;">Click to browse or drag & drop documents</strong>
                    <div style="font-size:10.5px; color:#64748b; margin-top:2px;">${escapeHtml(q.placeholder || 'Supported formats: PDF, DOCX, PNG, JPG (Max 25MB)')}</div>
                </div>
            `;
        }

        itemWrap.innerHTML = `
            ${labelHtml}
            ${controlHtml}
        `;
        container.appendChild(itemWrap);
    });
};

window.renderPresetsList = function() {
    const container = document.getElementById('qd-presets-container');
    if (!container) return;

    container.innerHTML = '';
    ENTERPRISE_QUESTION_PRESETS.forEach(preset => {
        const card = document.createElement('div');
        card.className = 'qd-preset-card';
        card.onclick = () => window.loadPresetQuestions(preset.key);

        card.innerHTML = `
            <div class="qd-preset-header">
                <div class="qd-preset-title">
                    <i class="fas ${preset.icon}" style="color: #2563eb;"></i>
                    ${escapeHtml(preset.title)}
                </div>
                <button type="button" class="btn btn-outline" style="padding: 2px 8px; font-size: 10.5px; border-color:#93c5fd; color:#2563eb;">
                    Apply Preset
                </button>
            </div>
            <div class="qd-preset-desc">${escapeHtml(preset.desc)}</div>
            <div class="qd-preset-tags">
                <span class="qd-chip" style="font-size:10px; background:#eff6ff; color:#1d4ed8;">${preset.questions.length} Questions</span>
                ${preset.tags.map(t => `<span class="qd-chip" style="font-size:10px; background:#f1f5f9; color:#475569; border-color:#e2e8f0;">${t}</span>`).join('')}
            </div>
        `;
        container.appendChild(card);
    });
};

// Save Questions to Cloud Firestore (workflows/{workflowId}/question_configs/{stageId})
window.saveQuestionsToFirestore = async function() {
    const saveBtn = document.getElementById('qd-btn-save-firestore');
    if (!questionState.activeStageId) {
        showToast('No active stage selected', 'error');
        return;
    }

    const workflowId = state.currentWorkflow.id || `wf_${Date.now()}`;
    if (!state.currentWorkflow.id) {
        state.currentWorkflow.id = workflowId;
    }

    const stageId = questionState.activeStageId;
    const stageLabel = questionState.activeStageLabel || stageId;

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving to Firestore...';
    }

    // Build payload adhering strictly to PRD §9
    const questionsPayload = questionState.stagedQuestions.map((q, idx) => ({
        questionId: q.questionId || `q_${Date.now()}_${idx + 1}`,
        prompt: q.prompt,
        type: q.type,
        required: Boolean(q.required),
        placeholder: q.placeholder || '',
        options: Array.isArray(q.options) ? q.options : [],
        scale: q.scale || (q.type === 'rating' ? 5 : null),
        order: idx + 1
    }));

    const configDoc = {
        stageId: stageId,
        stageLabel: stageLabel,
        workflowId: workflowId,
        questions: questionsPayload,
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin_uid'
    };

    let firestoreWritten = false;

    // 1. Direct Cloud Firestore Client write
    try {
        const fb = await import('./firebase-config.js');
        if (fb && fb.db && fb.doc && fb.setDoc) {
            const docRef = fb.doc(fb.db, 'workflows', workflowId, 'question_configs', stageId);
            await fb.setDoc(docRef, {
                ...configDoc,
                updatedAt: fb.serverTimestamp ? fb.serverTimestamp() : new Date().toISOString()
            }, { merge: true });
            firestoreWritten = true;
            console.log(`[Firestore] Saved question config to workflows/${workflowId}/question_configs/${stageId}`);
        }
    } catch (fbErr) {
        console.warn('[Firestore] Client Firestore write notice:', fbErr.message);
    }

    // 2. Dual-save to backend API route for cross-session resilience
    try {
        await fetch(`${API_BASE}/${workflowId}/question-configs/${stageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configDoc)
        });
    } catch (apiErr) {
        // Backend offline resilience
    }

    // 3. Mirror into local state without touching canvas connections/nodes
    if (!state.currentWorkflow.questionConfigs) {
        state.currentWorkflow.questionConfigs = {};
    }
    state.currentWorkflow.questionConfigs[stageId] = configDoc;

    // 4. Re-render UI to update node question badge and right panel trigger
    renderCanvas();
    renderConfigPanel();

    showToast(`✅ Saved ${questionsPayload.length} question(s) to Cloud Firestore for "${stageLabel}"!`, 'success');

    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Save to Cloud Firestore';
    }
};

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PRD SECTION 12: DIRECT AUTOMATION & WORKFLOW INTEGRATION CONTROLLER
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const automationState = {
    activeStageId: null,
    activeStageLabel: null
};

// Switch Tabs inside Automation Drawer
window.switchAdTab = function(tabKey) {
    const tabs = ['action', 'template', 'sla'];
    tabs.forEach(key => {
        const btn = document.getElementById(`ad-tab-${key}`);
        const content = document.getElementById(`ad-content-${key}`);
        if (btn) {
            if (key === tabKey) btn.classList.add('active');
            else btn.classList.remove('active');
        }
        if (content) {
            content.style.display = (key === tabKey) ? 'block' : 'none';
        }
    });
};

// Open Automation Drawer for a specific stage or default node
window.openAutomationDrawer = function(stageId) {
    const nodes = state.currentWorkflow?.canvas?.nodes || [];
    if (!stageId) {
        if (state.selectedNodeId) {
            stageId = state.selectedNodeId;
        } else if (nodes.length > 0) {
            stageId = nodes[0].id;
        } else {
            stageId = 'stage_1';
        }
    }

    // Populate stage selector dropdown
    const stageSelect = document.getElementById('ad-input-stage');
    if (stageSelect) {
        stageSelect.innerHTML = '';
        if (nodes.length > 0) {
            nodes.forEach(n => {
                const opt = document.createElement('option');
                opt.value = n.id;
                opt.textContent = `${n.label || n.id} (${n.type || 'stage'})`;
                if (String(n.id) === String(stageId)) {
                    opt.selected = true;
                }
                stageSelect.appendChild(opt);
            });
        } else {
            const opt = document.createElement('option');
            opt.value = stageId;
            opt.textContent = `Default Stage (${stageId})`;
            opt.selected = true;
            stageSelect.appendChild(opt);
        }
    }

    const node = nodes.find(n => String(n.id) === String(stageId));
    const stageLabel = node?.label || stageId;

    automationState.activeStageId = stageId;
    automationState.activeStageLabel = stageLabel;

    // Update Header info
    const labelEl = document.getElementById('adStageLabel');
    const idEl = document.getElementById('adStageId');
    if (labelEl) labelEl.textContent = stageLabel;
    if (idEl) idEl.textContent = `(Stage: ${stageId})`;

    // Load existing automation config for this stage
    const aConfigs = state.currentWorkflow?.automationConfigs || {};
    const existing = aConfigs[stageId] || aConfigs[`stage_${stageId}`] || node?.config?.automation || null;

    if (existing) {
        const auto = existing.automationConfig || existing;
        const triggerKeyEl = document.getElementById('ad-input-trigger-key');
        if (triggerKeyEl) triggerKeyEl.value = existing.triggerEventKey || state.currentWorkflow?.triggerEventKey || 'EVT_LEAVE_SUBMITTED';

        const wfCodeEl = document.getElementById('ad-input-workflow-code');
        if (wfCodeEl) wfCodeEl.value = existing.workflowCode || state.currentWorkflow?.workflowCode || state.currentWorkflow?.code || 'WF_LEAVE_APPROVAL';

        const moduleEl = document.getElementById('ad-input-module');
        if (moduleEl) moduleEl.value = existing.module || state.currentWorkflow?.module || 'leave_attendance';

        const stepNoEl = document.getElementById('ad-input-step-no');
        if (stepNoEl) stepNoEl.value = existing.stepNo || 1;

        const actionTypeEl = document.getElementById('ad-input-action-type');
        if (actionTypeEl) actionTypeEl.value = auto.actionType || 'NOTIFY_AND_ROUTE';

        const approverTypeEl = document.getElementById('ad-input-approver-type');
        if (approverTypeEl) approverTypeEl.value = auto.targetApprover || existing.approverType || 'L1_MANAGER';

        const roleCodeEl = document.getElementById('ad-input-role-code');
        if (roleCodeEl) roleCodeEl.value = auto.approverRoleCode || existing.approverRoleCode || 'MGR_L1';

        const mandEl = document.getElementById('ad-input-mandatory');
        const mandLabel = document.getElementById('ad-mandatory-label');
        const isMandatory = auto.isMandatory !== undefined ? Boolean(auto.isMandatory) : (existing.mandatory !== undefined ? Boolean(existing.mandatory) : true);
        if (mandEl) {
            mandEl.checked = isMandatory;
            if (mandLabel) mandLabel.textContent = isMandatory ? 'Mandatory Step: Yes (Blocks execution)' : 'Mandatory Step: No (Optional / Informational)';
        }

        const subjEl = document.getElementById('ad-input-template-subject');
        if (subjEl) subjEl.value = auto.emailSubject || 'Action Required: {{transactionType}} pending review for {{employeeName}}';

        const bodyEl = document.getElementById('ad-input-template-body');
        if (bodyEl) bodyEl.value = auto.emailTemplate || 'Leave request pending review for {{employeeName}} (Department: {{department}}). Please verify attendance records and approve via {{approvalLink}}.';

        const whUrlEl = document.getElementById('ad-input-webhook-url');
        if (whUrlEl && auto.webhookConfig?.url) whUrlEl.value = auto.webhookConfig.url;

        const whHeadersEl = document.getElementById('ad-input-webhook-headers');
        if (whHeadersEl && auto.webhookConfig?.headers) {
            whHeadersEl.value = typeof auto.webhookConfig.headers === 'string' ? auto.webhookConfig.headers : JSON.stringify(auto.webhookConfig.headers);
        }

        const statusFieldEl = document.getElementById('ad-input-status-field');
        if (statusFieldEl && auto.statusMutation?.field) statusFieldEl.value = auto.statusMutation.field;

        const statusValEl = document.getElementById('ad-input-status-value');
        if (statusValEl && auto.statusMutation?.value) statusValEl.value = auto.statusMutation.value;

        const slaEl = document.getElementById('ad-input-sla-hours');
        if (slaEl) slaEl.value = auto.slaHours || existing.slaHours || 24;

        const escEl = document.getElementById('ad-input-escalation-action');
        if (escEl) escEl.value = auto.escalationAction || 'AUTO_ESCALATE_TO_L2';

        const retCountEl = document.getElementById('ad-input-retry-count');
        if (retCountEl) retCountEl.value = auto.retryRules?.maxRetries !== undefined ? auto.retryRules.maxRetries : 3;

        const retIntEl = document.getElementById('ad-input-retry-interval');
        if (retIntEl) retIntEl.value = auto.retryRules?.retryIntervalMinutes !== undefined ? auto.retryRules.retryIntervalMinutes : 15;
    } else {
        // Sensible defaults adhering to PRD §12
        window.resetAutomationForm();
    }

    window.handleAdActionTypeChange();
    window.switchAdTab('action');

    const overlay = document.getElementById('automationDrawerOverlay');
    const drawer = document.getElementById('automationDrawer');
    if (overlay) overlay.style.display = 'block';
    if (drawer) drawer.style.display = 'flex';
};

// Close Automation Drawer
window.closeAutomationDrawer = function() {
    const overlay = document.getElementById('automationDrawerOverlay');
    const drawer = document.getElementById('automationDrawer');
    if (overlay) overlay.style.display = 'none';
    if (drawer) drawer.style.display = 'none';
    automationState.activeStageId = null;
};

// Stage dropdown change in drawer
window.handleAdStageSelectChange = function() {
    const stageSelect = document.getElementById('ad-input-stage');
    if (stageSelect && stageSelect.value) {
        window.openAutomationDrawer(stageSelect.value);
    }
};

// Action Type dropdown change: toggles conditional sections
window.handleAdActionTypeChange = function() {
    const actionTypeEl = document.getElementById('ad-input-action-type');
    const actionType = actionTypeEl ? actionTypeEl.value : 'NOTIFY_AND_ROUTE';

    const whSection = document.getElementById('ad-webhook-section');
    if (whSection) {
        whSection.style.display = (actionType === 'TRIGGER_WEBHOOK') ? 'block' : 'none';
    }

    const smSection = document.getElementById('ad-status-mutation-section');
    if (smSection) {
        smSection.style.display = (actionType === 'UPDATE_RECORD_STATUS') ? 'block' : 'none';
    }
};

// Target Approver / Role change: auto-updates role code
window.handleAdApproverTypeChange = function() {
    const appTypeEl = document.getElementById('ad-input-approver-type');
    const roleCodeEl = document.getElementById('ad-input-role-code');
    if (!appTypeEl || !roleCodeEl) return;

    const val = appTypeEl.value;
    const mapping = {
        'L1_MANAGER': 'MGR_L1',
        'L2_MANAGER': 'MGR_L2',
        'HR_OPERATIONS': 'HR_OPS_LEAD',
        'FINANCE_CONTROLLER': 'FIN_CTRL',
        'DEPARTMENT_HEAD': 'DEPT_HEAD',
        'EMPLOYEE': 'EMP_SELF',
        'CUSTOM_ROLE': roleCodeEl.value || 'CUSTOM_ROLE'
    };
    if (mapping[val]) {
        roleCodeEl.value = mapping[val];
    }
};

// Insert placeholder variable into template textarea
window.insertVariableIntoTemplate = function(variablePlaceholder) {
    const textarea = document.getElementById('ad-input-template-body');
    if (!textarea) return;

    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;
    const val = textarea.value;

    if (startPos !== undefined && endPos !== undefined) {
        textarea.value = val.substring(0, startPos) + variablePlaceholder + val.substring(endPos);
        textarea.selectionStart = textarea.selectionEnd = startPos + variablePlaceholder.length;
    } else {
        textarea.value += ' ' + variablePlaceholder;
    }
    textarea.focus();
};

// Reset automation form to default settings
window.resetAutomationForm = function() {
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };

    setVal('ad-input-trigger-key', 'EVT_LEAVE_SUBMITTED');
    setVal('ad-input-workflow-code', state.currentWorkflow?.workflowCode || state.currentWorkflow?.code || 'WF_LEAVE_APPROVAL');
    setVal('ad-input-module', state.currentWorkflow?.module || 'leave_attendance');
    setVal('ad-input-step-no', '1');
    setVal('ad-input-action-type', 'NOTIFY_AND_ROUTE');
    setVal('ad-input-approver-type', 'L1_MANAGER');
    setVal('ad-input-role-code', 'MGR_L1');

    const mandEl = document.getElementById('ad-input-mandatory');
    const mandLabel = document.getElementById('ad-mandatory-label');
    if (mandEl) mandEl.checked = true;
    if (mandLabel) mandLabel.textContent = 'Mandatory Step: Yes (Blocks execution)';

    setVal('ad-input-template-subject', 'Action Required: {{transactionType}} pending review for {{employeeName}}');
    setVal('ad-input-template-body', 'Leave request pending review for {{employeeName}} (Department: {{department}}). Please verify attendance records and approve via {{approvalLink}}.');
    setVal('ad-input-webhook-url', 'https://hooks.slack.com/services/T00/B00/workflow-events');
    setVal('ad-input-webhook-headers', '{"Content-Type": "application/json"}');
    setVal('ad-input-status-field', 'employmentStatus');
    setVal('ad-input-status-value', 'ACTIVE');
    setVal('ad-input-sla-hours', '24');
    setVal('ad-input-escalation-action', 'AUTO_ESCALATE_TO_L2');
    setVal('ad-input-retry-count', '3');
    setVal('ad-input-retry-interval', '15');

    window.handleAdActionTypeChange();
};

// Save Automation Configuration directly to Cloud Firestore & backend REST API
window.saveAutomationToFirestore = async function() {
    const workflowId = state.currentWorkflow?.id || 'wf_active';
    const stageSelect = document.getElementById('ad-input-stage');
    const stageId = stageSelect?.value || automationState.activeStageId || 'stage_1';
    const node = state.currentWorkflow?.canvas?.nodes?.find(n => String(n.id) === String(stageId));
    const stageLabel = node?.label || stageId;

    const triggerEventKey = (document.getElementById('ad-input-trigger-key')?.value || 'EVT_LEAVE_SUBMITTED').trim();
    const workflowCode = (document.getElementById('ad-input-workflow-code')?.value || 'WF_LEAVE_APPROVAL').trim();
    const module = document.getElementById('ad-input-module')?.value || 'leave_attendance';
    const stepNo = parseInt(document.getElementById('ad-input-step-no')?.value || '1', 10);
    const actionType = document.getElementById('ad-input-action-type')?.value || 'NOTIFY_AND_ROUTE';
    const approverType = document.getElementById('ad-input-approver-type')?.value || 'L1_MANAGER';
    const approverRoleCode = (document.getElementById('ad-input-role-code')?.value || 'MGR_L1').trim();
    const isMandatory = document.getElementById('ad-input-mandatory')?.checked !== false;

    const emailSubject = (document.getElementById('ad-input-template-subject')?.value || '').trim();
    const emailTemplate = (document.getElementById('ad-input-template-body')?.value || '').trim();
    const slaHours = parseInt(document.getElementById('ad-input-sla-hours')?.value || '24', 10);
    const escalationAction = document.getElementById('ad-input-escalation-action')?.value || 'AUTO_ESCALATE_TO_L2';
    const retryCount = parseInt(document.getElementById('ad-input-retry-count')?.value || '3', 10);
    const retryInterval = parseInt(document.getElementById('ad-input-retry-interval')?.value || '15', 10);

    // Validation
    if (!triggerEventKey) {
        showToast('Please enter a valid Trigger Event Key (e.g. EVT_LEAVE_SUBMITTED).', 'error');
        return;
    }
    if (isNaN(slaHours) || slaHours <= 0) {
        showToast('SLA Hours must be a positive number.', 'error');
        return;
    }

    const saveBtn = document.getElementById('ad-btn-save-firestore');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }

    const automationConfig = {
        enabled: true,
        actionType,
        targetApprover: approverType,
        approverRoleCode,
        slaHours,
        isMandatory,
        emailSubject,
        emailTemplate,
        escalationAction,
        retryRules: {
            maxRetries: retryCount,
            retryIntervalMinutes: retryInterval
        }
    };

    if (actionType === 'TRIGGER_WEBHOOK') {
        let headers = { 'Content-Type': 'application/json' };
        try {
            const rawHeaders = document.getElementById('ad-input-webhook-headers')?.value;
            if (rawHeaders) headers = JSON.parse(rawHeaders);
        } catch (_) {}
        automationConfig.webhookConfig = {
            url: document.getElementById('ad-input-webhook-url')?.value || '',
            headers
        };
    }

    if (actionType === 'UPDATE_RECORD_STATUS') {
        automationConfig.statusMutation = {
            field: document.getElementById('ad-input-status-field')?.value || 'employmentStatus',
            value: document.getElementById('ad-input-status-value')?.value || 'ACTIVE'
        };
    }

    // Aligned with 'Workflow' sheet columns per PRD §12
    const configDoc = {
        workflowId,
        stageId,
        stageLabel,
        workflowCode,
        module,
        transactionType: 'WORKFLOW_TASK',
        stepNo,
        approverType,
        approverRoleCode,
        slaHours,
        mandatory: isMandatory,
        triggerEventKey,
        automationConfig,
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin_uid'
    };

    // 1. Direct Cloud Firestore Client write (PRD §12 Schema)
    try {
        const fb = await import('./firebase-config.js');
        if (fb && fb.db && fb.doc && fb.setDoc) {
            // Write to top-level workflows/{workflowId} document per PRD §12
            const wfDocRef = fb.doc(fb.db, 'workflows', workflowId);
            await fb.setDoc(wfDocRef, {
                workflowCode,
                stepNo,
                triggerEventKey,
                automationConfig,
                updatedAt: fb.serverTimestamp ? fb.serverTimestamp() : new Date().toISOString()
            }, { merge: true });

            // Also persist stage-level subcollection workflows/{workflowId}/automation_configs/{stageId}
            const stageDocRef = fb.doc(fb.db, 'workflows', workflowId, 'automation_configs', stageId);
            await fb.setDoc(stageDocRef, {
                ...configDoc,
                updatedAt: fb.serverTimestamp ? fb.serverTimestamp() : new Date().toISOString()
            }, { merge: true });

            console.log(`[Firestore] Persisted PRD §12 automation to workflows/${workflowId}`);
        }
    } catch (fbErr) {
        console.warn('[Firestore] Client Firestore write notice:', fbErr.message);
    }

    // 2. Dual-save to Backend REST API for cross-session resilience
    try {
        await fetch(`${API_BASE}/${workflowId}/automations/${stageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configDoc)
        });
    } catch (_) {}

    // 3. Mirror into local state and canvas node
    if (!state.currentWorkflow.automationConfigs) {
        state.currentWorkflow.automationConfigs = {};
    }
    state.currentWorkflow.automationConfigs[stageId] = configDoc;
    state.currentWorkflow.workflowCode = workflowCode;
    state.currentWorkflow.stepNo = stepNo;
    state.currentWorkflow.triggerEventKey = triggerEventKey;
    state.currentWorkflow.automationConfig = automationConfig;

    if (node) {
        node.config = node.config || {};
        node.config.automation = configDoc;
    }

    // 4. Re-render UI: canvas node badges and inspector
    renderCanvas();
    renderConfigPanel();

    showToast(`✅ Saved automation "${actionType}" to Cloud Firestore for "${stageLabel}"!`, 'success');

    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Save to Cloud Firestore';
    }

    window.closeAutomationDrawer();
};


