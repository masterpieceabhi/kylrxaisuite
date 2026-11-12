/**
 * E-signature storage layer (Firestore + encrypted vault). Shared by the signed-in API
 * (routes/us-esign.js) and the public sign page (routes/public-recruiting.js).
 */
const { admin, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const E = require('./esign-rules');
const V = require('./vault-rules');
const store = require('./file-store');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();

/** Audit entry for actions with no signed-in user (public sign page, public applications) */
function auditPublic(orgId, action, targetId, ip, extra = {}) {
    return rawCollection('organizations').doc(orgId).collection('audit_logs').add({ action, targetId, actorId: null, actorRole: 'public', at: nowIso(), ip: ip || null, ...extra })
        .catch((e) => logger.error(`Public audit write failed: ${e.message}`));
}

const companyNameOf = (org) => String((org && (org.name || org.companyName || (org.usProfile && org.usProfile.legalName))) || 'the Company');
const splitName = (n) => { const p = String(n || '').trim().split(/\s+/); return { first: p[0] || '', last: p.slice(1).join(' ') }; };
const FIELD_KEYS = new Set(E.MERGE_FIELDS);

/** Merge values for a signer. extra can only set known fields (it wins over what is on file). */
async function mergeValues(orgId, org, signer, extra, todayIso) {
    const v = { company_name: companyNameOf(org), today: todayIso };
    if (signer.type === 'employee') {
        const u = signer.data;
        const n = splitName(u.name);
        let managerName = '';
        const mid = u.usProfile && u.usProfile.managerId;
        if (mid) { const m = await rawCollection('users').doc(String(mid)).get(); if (exists(m) && m.data().orgId === orgId) managerName = m.data().name || ''; }
        Object.assign(v, {
            first_name: (u.usProfile && u.usProfile.legalFirstName) || n.first, last_name: (u.usProfile && u.usProfile.legalLastName) || n.last, full_name: u.name || '', email: u.email || '',
            job_title: u.jobTitle || '', department: u.departmentName || '', start_date: (u.usProfile && u.usProfile.startDate) || u.joiningDate || '', work_state: (u.usProfile && u.usProfile.workState) || '', manager_name: managerName
        });
    } else {
        const c = signer.data; const o = c.offer || {};
        Object.assign(v, {
            first_name: c.firstName || '', last_name: c.lastName || '', full_name: c.name || '', email: c.email || '', job_title: o.jobTitle || c.requisitionTitle || '', department: c.department || '',
            start_date: o.startDate || '', pay_rate: o.payRate !== undefined ? Number(o.payRate).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '', pay_unit: o.payUnit || ''
        });
    }
    for (const [k, val] of Object.entries(extra || {})) if (FIELD_KEYS.has(k) && val !== undefined && val !== null && String(val).trim() !== '') v[k] = String(val).slice(0, 300);
    return v;
}

function signUrl(req, token) {
    return `/sign.html?t=${encodeURIComponent(token)}`;
}

/** Records a log line on the request document itself (its audit trail) */
const histEntry = (event, ip, extra) => ({ at: nowIso(), event, ip: ip || null, ...(extra || {}) });

async function findByToken(token) {
    if (!E.isTokenShape(token)) return null;
    const q = await rawCollection('sign_requests').where('tokenHash', '==', E.sha256(token)).limit(1).get();
    if (q.empty) return null;
    return { ref: q.docs[0].ref, id: q.docs[0].id, data: q.docs[0].data() };
}

/**
 * Finishes a signature: builds the certificate, stores it encrypted in the vault, flips the request to
 * signed in a transaction, and links the result to the candidate (offer accepted). Throws { conflict }.
 */
async function completeSigning(reqDoc, sig, ctx) {
    const { id, ref, data } = reqDoc;
    const signedAt = nowIso();
    const org = (await rawCollection('organizations').doc(data.orgId).get());
    const orgData = exists(org) ? org.data() : {};
    const consentText = E.CONSENT_TEXT[ctx.lang === 'es' ? 'es' : 'en'];
    const history = [...(data.history || []), histEntry('signed', ctx.ip, { typedName: sig.typedName })];
    const certificate = E.buildCertificate({
        templateName: data.templateName, signerName: data.signerName, signerEmail: data.signerEmail, signedAt, ip: ctx.ip, userAgent: ctx.userAgent, documentHash: data.documentHash,
        requestId: id, companyName: companyNameOf(orgData), consentText, typedName: sig.typedName, signatureData: sig.signatureData, renderedHtml: data.renderedHtml, history
    });
    const buf = Buffer.from(certificate, 'utf8');
    const type = E.typeOf(data.templateType) || E.typeOf('custom');
    const vaultRef = rawCollection('vault_documents').doc();
    await store.saveFile(data.orgId, vaultRef.id, buf);
    const isEmployee = data.signerType === 'employee';
    const vaultDoc = {
        orgId: data.orgId, scope: 'employee', category: type.vaultCategory, title: `${data.templateName} - signed (${data.signerName})`.slice(0, 120), userId: isEmployee ? data.userId : null,
        candidateId: isEmployee ? null : data.candidateId, employeeName: isEmployee ? data.signerName : null, fileName: `signed-${data.templateType}-${id}.html`, mime: 'text/html', size: buf.length,
        sha256: E.sha256(buf), uploadedAt: signedAt, uploadedBy: 'esign', expiresOn: null, shared: isEmployee, confidential: false, deleted: false, legalHold: false,
        retainUntil: V.retainUntil(type.vaultCategory, signedAt), source: 'esign', signRequestId: id
    };
    try {
        await vaultRef.set(vaultDoc);
        await admin.firestore().runTransaction(async (tx) => {
            const cur = await tx.get(ref);
            const d = cur.data();
            if (!E.OPEN_STATUSES.includes(d.status)) { const e = new Error('This document is no longer open for signing'); e.conflict = true; throw e; }
            tx.update(ref, {
                status: 'signed', signedAt, signature: { typedName: sig.typedName, signatureData: sig.signatureData, ip: ctx.ip || null, userAgent: String(ctx.userAgent || '').slice(0, 300), consentText, consentLang: ctx.lang === 'es' ? 'es' : 'en' },
                vaultDocumentId: vaultRef.id, certificateHash: vaultDoc.sha256, history, tokenUsedAt: signedAt
            });
        });
    } catch (e) {
        await store.removeFile(data.orgId, vaultRef.id).catch(() => {});
        await vaultRef.delete().catch(() => {});
        throw e;
    }
    // A signed offer letter marks the candidate's offer as accepted
    if (data.signerType === 'candidate' && data.candidateId && data.templateType === 'offer_letter') {
        const cref = rawCollection('candidates').doc(data.candidateId);
        const c = await cref.get();
        if (exists(c) && c.data().orgId === data.orgId) {
            await cref.update({ offerStatus: 'accepted', offerAcceptedAt: signedAt, offerSignRequestId: id });
            await rawCollection('candidate_events').add({ orgId: data.orgId, candidateId: data.candidateId, type: 'offer_accepted', at: signedAt, by: 'esign', data: { signRequestId: id } });
        }
    }
    auditPublic(data.orgId, 'esign_document_signed', id, ctx.ip, { templateType: data.templateType, signerType: data.signerType, vaultDocumentId: vaultRef.id });
    return { signedAt, vaultDocumentId: vaultRef.id, documentHash: data.documentHash };
}

/** Public-safe view of a request */
const publicRequest = (id, d, nowStr) => ({
    id, templateId: d.templateId, templateName: d.templateName, templateType: d.templateType, signerType: d.signerType, signerName: d.signerName, signerEmail: d.signerEmail || null,
    userId: d.userId || null, candidateId: d.candidateId || null, status: E.effectiveStatus(d, nowStr), createdAt: d.createdAt, sentAt: d.sentAt, expiresAt: d.expiresAt, viewedAt: d.viewedAt || null,
    signedAt: d.signedAt || null, declinedAt: d.declinedAt || null, declineReason: d.declineReason || null, attempts: d.attempts || 0, maxAttempts: d.maxAttempts, documentHash: d.documentHash,
    vaultDocumentId: d.vaultDocumentId || null, reminders: (d.reminders || []).length, hasSignature: Boolean(d.signature)
});

module.exports = { exists, nowIso, auditPublic, companyNameOf, mergeValues, signUrl, histEntry, findByToken, completeSigning, publicRequest };
