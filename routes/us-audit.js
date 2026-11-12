/**
 * Audit log viewer (audit.view: owner, HR admin, auditor; all read-only). Reads organizations/{orgId}/audit_logs.
 * Searching is done by scanning newest-first in pages, so no composite indexes are needed.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission } = require('../services/permissions');
const chain = require('../services/audit-chain');

router.use(verifyToken);
const guard = [requirePermission('audit.view'), requireUsOrg];

const MAX_SCAN = 5000;
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

/** Friendly labels for known actions. Unknown ones are made readable automatically, so new modules need no change here. */
const LABELS = {
    us_employee_created: 'Employee added', us_employees_bulk_created: 'Employees added in bulk', us_employee_profile_updated: 'Employee profile updated', us_company_profile_updated: 'Company profile updated',
    us_taxpayer_id_revealed: 'Taxpayer ID revealed', us_w4_submitted: 'W-4 submitted', us_i9_section1_submitted: 'I-9 section 1 completed', us_i9_section2_completed: 'I-9 section 2 completed', us_direct_deposit_updated: 'Direct deposit changed',
    us_termination_recorded: 'Termination recorded', us_termination_cancelled: 'Termination cancelled', us_termination_effective: 'Termination took effect', us_rehired: 'Person rehired',
    time_punch_added_manually: 'Time punch added by hand', time_rules_updated: 'Time rules changed', timesheet_reopened: 'Timesheet reopened',
    leave_requested: 'Time off requested', leave_cancelled: 'Time off cancelled', leave_policy_created: 'Leave policy created', leave_policy_updated: 'Leave policy updated', leave_policy_archived: 'Leave policy archived', leave_balance_adjusted: 'Leave balance adjusted',
    vault_document_uploaded: 'Document uploaded', vault_document_downloaded: 'Document downloaded', vault_document_updated: 'Document updated', vault_document_deleted: 'Document deleted',
    eeo_selfid_submitted: 'EEO self-identification submitted', eeo_job_category_set: 'EEO job category set', eeo_report_viewed: 'EEO report viewed', osha_incident_reported: 'OSHA incident reported', osha_incident_classified: 'OSHA incident classified', posting_recorded: 'Required notice recorded',
    billing_subscribed: 'Subscription started', billing_plan_changed: 'Billing plan changed', billing_cancelled: 'Subscription cancelled', billing_payment_method_updated: 'Payment method updated', billing_invoice_downloaded: 'Invoice downloaded', billing_invoice_pay_attempt: 'Invoice payment attempted', billing_settings_updated: 'Billing settings changed',
    privacy_request_created: 'Privacy request received', privacy_request_status_changed: 'Privacy request status changed', privacy_request_extended: 'Privacy request deadline extended', privacy_access_export_generated: 'Privacy access export generated', privacy_export_downloaded: 'Privacy export downloaded', privacy_deletion_previewed: 'Privacy deletion previewed', privacy_deletion_executed: 'Personal data deleted or anonymized', privacy_flags_applied: 'Privacy choice applied', privacy_settings_updated: 'Privacy settings changed',
    audit_viewed: 'Audit log searched', audit_exported: 'Audit log exported', audit_chain_verified: 'Audit integrity check run', retention_job_run: 'Retention job run', retention_job_previewed: 'Retention job previewed',
    clock_policy_saved: 'Clock-in policy saved', clock_policy_removed: 'Clock-in policy removed', clock_consent_revoked: 'Clock-in consent revoked', punch_photo_viewed: 'Punch photo viewed', punch_photos_purged: 'Punch photos purged',
    sso_settings_updated: 'Single sign-on settings changed', support_access_granted: 'Support access granted', support_access_revoked: 'Support access revoked', support_session_started: 'Support session started',
    checklist_task_added: 'Checklist task added', checklist_task_updated: 'Checklist task updated', kiosk_pin_set: 'Kiosk PIN set'
};
const label = (a) => LABELS[a] || String(a || 'unknown').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Never show anything that looks like a secret even if a module logged it by mistake */
const SECRET_KEY = /pass(word)?|secret|token|ssn|taxpayerid(?!last4)|accountnumber|encrypted|authorization|api[_-]?key/i;
function clean(v, depth = 0) {
    if (v === null || typeof v !== 'object' || depth > 4) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[hidden]' : clean(val, depth + 1);
    return out;
}

const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);

function filtersFrom(q) {
    const f = {
        actor: String(q.actor || '').trim().toLowerCase(), action: String(q.action || '').trim(), target: String(q.target || '').trim().toLowerCase(),
        from: isoDay(q.from), to: isoDay(q.to), text: String(q.q || '').trim().toLowerCase()
    };
    return f;
}

function matches(e, f, names) {
    if (f.action && e.action !== f.action) return false;
    if (f.actor) {
        const n = (names.get(e.actorId) || '').toLowerCase();
        if (!(String(e.actorId || '').toLowerCase().includes(f.actor) || n.includes(f.actor) || String(e.actorRole || '').toLowerCase() === f.actor)) return false;
    }
    if (f.target && !String(e.targetId || '').toLowerCase().includes(f.target)) return false;
    if (f.text && !(JSON.stringify(e).toLowerCase().includes(f.text) || label(e.action).toLowerCase().includes(f.text))) return false;
    return true;
}

async function nameMap(orgId, ids) {
    const names = new Map();
    await Promise.all([...new Set(ids.filter(Boolean))].slice(0, 200).map(async (id) => {
        try { const s = await rawCollection('users').doc(String(id)).get(); if (exists(s) && s.data().orgId === orgId) names.set(id, s.data().name || s.data().email || null); } catch (_) {}
    }));
    return names;
}

/** Scans newest-first from `after` (a doc id) until `want` matches are found or the scan limit is hit */
async function scan(orgId, f, { want, after, maxScan = MAX_SCAN }) {
    const col = rawCollection('organizations').doc(orgId).collection('audit_logs');
    const PAGE = 500;
    let q = col.orderBy('at', 'desc');
    if (f.to) q = q.where('at', '<', new Date(Date.parse(`${f.to}T00:00:00Z`) + 86400000).toISOString());
    if (f.from) q = q.where('at', '>=', `${f.from}T00:00:00.000Z`);
    if (after) { const s = await col.doc(String(after)).get(); if (exists(s)) q = q.startAfter(s); }
    const found = []; let scanned = 0; let last = null; let exhausted = false;
    // Actor names are needed for actor matching; resolve lazily per page
    while (found.length < want && scanned < maxScan) {
        const snap = await q.limit(PAGE).get();
        if (snap.empty) { exhausted = true; break; }
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const names = f.actor ? await nameMap(orgId, rows.map((r) => r.actorId)) : new Map();
        for (const r of rows) { scanned += 1; last = r.id; if (matches(r, f, names)) { found.push(r); if (found.length >= want) break; } }
        if (snap.size < PAGE) { exhausted = true; break; }
        if (found.length < want) q = q.startAfter(snap.docs[snap.docs.length - 1]);
    }
    return { found, scanned, last, exhausted: exhausted && found.length < want };
}

function shape(e, names) {
    const { id, action, targetId, actorId, actorRole, at, ip, chain: c, ...extra } = e;
    return { id, at, action, actionLabel: label(action), actorId: actorId || null, actorName: names.get(actorId) || null, actorRole: actorRole || null, targetId: targetId || null, ip: ip || null, details: clean(extra), chained: Boolean(c && c.seq), seq: c ? c.seq : null };
}

router.get('/audit/actions', ...guard, (req, res) => {
    res.json({ success: true, data: Object.entries(LABELS).map(([key, name]) => ({ key, label: name })).sort((a, b) => a.label.localeCompare(b.label)) });
});

router.get('/audit', ...guard, async (req, res) => {
    const f = filtersFrom(req.query);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const r = await scan(req.orgId, f, { want: limit + 1, after: req.query.cursor });
    const page = r.found.slice(0, limit);
    const names = await nameMap(req.orgId, page.map((p) => p.actorId));
    const more = r.found.length > limit;
    audit(req.orgId, req, 'audit_viewed', null, { filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
    res.json({
        success: true, count: page.length, data: page.map((e) => shape(e, names)), scanned: r.scanned,
        nextCursor: more ? page[page.length - 1].id : (r.exhausted ? null : r.last), hasMore: more || !r.exhausted,
        note: !more && !r.exhausted ? `Scanned ${r.scanned} entries without finding more matches; use Next to keep searching.` : undefined
    });
});

const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/audit/export.csv', ...guard, async (req, res) => {
    const f = filtersFrom(req.query);
    const r = await scan(req.orgId, f, { want: 10000, maxScan: 20000 });
    const names = await nameMap(req.orgId, r.found.map((p) => p.actorId));
    const rows = r.found.map((e) => shape(e, names));
    const lines = [['time', 'action', 'action_label', 'actor_id', 'actor_name', 'actor_role', 'target', 'ip', 'details'].join(',')]
        .concat(rows.map((x) => [x.at, x.action, x.actionLabel, x.actorId, x.actorName, x.actorRole, x.targetId, x.ip, x.details].map(csvCell).join(',')));
    audit(req.orgId, req, 'audit_exported', null, { rows: rows.length, filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-${req.orgId}-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.send('﻿' + lines.join('\r\n') + '\r\n');
});

/** Verifies the HMAC hash chain, if this company's entries carry one */
router.get('/audit/verify', ...guard, async (req, res) => {
    const org = rawCollection('organizations').doc(req.orgId);
    const snap = await org.collection('audit_logs').orderBy('at', 'desc').limit(20000).get();
    const entries = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    const headSnap = await org.collection('audit_chain').doc('head').get();
    let report;
    try { report = chain.verifyChain(entries, { head: exists(headSnap) ? headSnap.data() : undefined }); }
    catch (e) { return res.status(500).json({ success: false, error: 'Integrity key is not configured (AUDIT_CHAIN_KEY)' }); }
    audit(req.orgId, req, 'audit_chain_verified', null, { valid: report.valid, chained: report.chained, unchained: report.unchained });
    res.json({
        success: true, ...report,
        summary: report.chained === 0 ? 'No entries carry an integrity chain yet, so nothing can be verified. The chain is optional and can be adopted later.'
            : (report.valid ? `All ${report.chained} chained entries verified. ${report.unchained} older entries have no chain.` : `Integrity problem found at entry ${report.firstBreak && report.firstBreak.seq}: ${report.firstBreak && report.firstBreak.reason}.`)
    });
});

module.exports = router;
module.exports.helpers = { label, clean, LABELS, matches, csvCell };
