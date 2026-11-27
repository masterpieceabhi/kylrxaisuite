/**
 * Company data download and account closure (I/O). Rules are in company-data-rules.js.
 *
 *   buildExport(orgId)        a ZIP: every company record as JSON (secrets left out, encrypted numbers noted, not
 *                             included), every stored file decrypted, and a README
 *   requestClosure(...)       schedules deletion in 30 days, ends the subscription, emails the owner
 *   withdrawClosure(...)      undoes it before the day
 *   runDue(today)             daily: sends the reminder 3 days before, then deletes due companies and emails the
 *                             written confirmation. Off with COMPANY_DELETION=off (requests are still recorded).
 *
 * Deletion removes the company's records in every collection, its organizations record with everything under it,
 * its stored files and its people's sign-in accounts. Kept: our invoices to the company (tax records) and the closure
 * record itself (company name, dates, counts, never personal details), which is the proof of deletion. Backups
 * expire on their own within 35 days (services/daily-jobs.js keeps 35 days; Firestore backups are set to 5 weeks).
 */
const fs = require('fs');
const path = require('path');
const R = require('./company-data-rules');
const logger = require('../utils/logger');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const fb = () => require('../config/firebase');
const closures = () => fb().rawCollection('company_closures');
const PAGE = 300;

async function dbCollections() {
    try { const db = fb().db; if (db && typeof db.listCollections === 'function') return (await db.listCollections()).map((c) => c.id); } catch (e) { logger.warn(`[CompanyData] could not list collections: ${e.message}`); }
    return [];
}

/** Every document of a collection that belongs to the company, page by page. */
async function* companyDocs(name, orgId) {
    const { rawCollection, admin } = fb();
    let last = null;
    for (;;) {
        let q = rawCollection(name).where('orgId', '==', orgId);
        try { q = q.orderBy(admin.firestore.FieldPath.documentId()); } catch (_) { /* stand-in store */ }
        q = q.limit(PAGE);
        if (last) { try { q = q.startAfter(last); } catch (_) { /* stand-in store: one page */ } }
        const snap = await q.get();
        for (const d of snap.docs) yield d;
        if (snap.docs.length < PAGE || !last && snap.docs.length === 0) return;
        const next = snap.docs[snap.docs.length - 1];
        if (last && next.id === last.id) return;
        last = next;
    }
}

async function subcollectionDocs(ref) {
    const out = [];
    if (!ref || typeof ref.listCollections !== 'function') return out;
    for (const sub of await ref.listCollections()) {
        const snap = await sub.get();
        for (const d of snap.docs) { out.push(d); out.push(...await subcollectionDocs(d.ref)); }
    }
    return out;
}

async function orgRecord(orgId) {
    const snap = await fb().rawCollection('organizations').doc(orgId).get();
    return exists(snap) ? { id: snap.id, ref: snap.ref, ...snap.data() } : null;
}

const companyName = (org) => (org && (org.legalName || org.Legal_Name || org.name || org.companyName || org.Display_Name)) || 'Company';

function readme(org, counts, files, now) {
    return [
        `Onn HR data download for ${companyName(org)}`,
        `Made ${now.toISOString()}`,
        '',
        'data/<name>.json   one file per kind of record, as stored in Onn HR (dates in UTC).',
        'data/organization.json   the company record and its settings.',
        'files/             documents, signed forms, photos and other files people uploaded, decrypted.',
        '',
        'Not included, on purpose:',
        '- Sign-in secrets (PIN and password hashes, authenticator keys, one-time codes, API and access tokens).',
        `- Social Security numbers, bank account numbers and document numbers. They are stored encrypted and show as "${R.ENCRYPTED_NOTE}".`,
        '  Your payroll provider (Gusto) holds the numbers it needs; each person\'s W-4 and I-9 files are in files/.',
        '',
        `Records: ${Object.values(counts).reduce((a, b) => a + b, 0)} in ${Object.keys(counts).length} files. Files: ${files}.`,
        '',
        'Keep this file safe: it contains personal information about your people.',
        'Questions: support@promptaiusa.com'
    ].join('\r\n');
}

/** The whole company as one ZIP Buffer, plus counts for the audit log. */
async function buildExport(orgId, { now = new Date() } = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(orgId || ''))) throw Object.assign(new Error('Invalid company'), { statusCode: 400 });
    const org = await orgRecord(orgId);
    if (!org) throw Object.assign(new Error('Company not found'), { statusCode: 404 });
    const entries = []; const counts = {};
    const { ref: orgRef, ...orgData } = org;
    const orgSubs = await subcollectionDocs(orgRef);
    entries.push({ name: 'data/organization.json', data: JSON.stringify({ organization: R.cleanRecord(orgData), settings: orgSubs.map((d) => ({ path: d.ref.path.split('/').slice(2).join('/'), ...R.cleanRecord(d.data()) })) }, null, 2) });
    const fileNames = new Map();
    for (const name of R.exportPlan(await dbCollections())) {
        const rows = [];
        for await (const d of companyDocs(name, orgId)) {
            const data = d.data();
            if (data.orgId !== orgId) continue;
            const subs = await subcollectionDocs(d.ref);
            rows.push({ id: d.id, ...R.cleanRecord(data), ...(subs.length ? { _inside: subs.map((s) => ({ path: s.ref.path.split('/').slice(2).join('/'), ...R.cleanRecord(s.data()) })) } : {}) });
            if (name === 'vault_documents' && data.fileName) fileNames.set(d.id, String(data.fileName));
        }
        if (!rows.length) continue;
        counts[name] = rows.length;
        entries.push({ name: `data/${name}.json`, data: JSON.stringify(rows, null, 2) });
    }
    // stored files (services/file-store.js): every file in the company's folder, decrypted
    const store = require('./file-store');
    let fileCount = 0; const failed = [];
    const dir = path.join(store.ROOT, orgId);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bin')) : [];
    for (const f of names) {
        const id = f.slice(0, -4);
        try {
            const buf = await store.readFile(orgId, id);
            const nice = fileNames.get(id);
            entries.push({ name: `files/${id}${nice ? `-${nice}` : ''}`, data: buf });
            fileCount += 1;
        } catch (e) { failed.push(id); }
    }
    if (failed.length) entries.push({ name: 'files/COULD_NOT_READ.txt', data: `These stored files could not be decrypted and are not included:\r\n${failed.join('\r\n')}` });
    entries.unshift({ name: 'README.txt', data: readme(org, counts, fileCount, now) });
    return { zip: R.zip(entries, now), counts, files: fileCount, unreadable: failed.length, companyName: companyName(org) };
}

/* ------------------------------------------------------------------ closure */

async function sendMail(to, subject, text) {
    if (!to) return false;
    try { await require('../utils/email').sendEmail({ to, subject, text }); return true; } catch (e) { logger.warn(`[CompanyData] email not sent: ${String(e.message || e).slice(0, 160)}`); return false; }
}

const appUrl = () => String(process.env.APP_URL || 'https://app.onnhr.com').replace(/\/+$/, '');

async function status(orgId) {
    const snap = await closures().doc(orgId).get();
    const c = exists(snap) ? snap.data() : null;
    return c && c.orgId === orgId ? c : null;
}

async function requestClosure(orgId, { typedName, by, byEmail, now = new Date() }) {
    const org = await orgRecord(orgId);
    if (!org) throw Object.assign(new Error('Company not found'), { statusCode: 404 });
    if (!R.nameMatches(typedName, org)) throw Object.assign(new Error(`Type the company name exactly as it shows: ${companyName(org)}`), { statusCode: 400 });
    const had = await status(orgId);
    if (R.isScheduled(had)) throw Object.assign(new Error(`Closing is already set for ${had.deleteOn}`), { statusCode: 409 });
    const c = { orgId, ...R.newClosure({ now, by, byEmail, companyName: companyName(org) }) };
    await closures().doc(orgId).set(c);
    await org.ref.set({ closure: { state: c.state, deleteOn: c.deleteOn, requestedAt: c.requestedAt } }, { merge: true });
    // stop billing now; the account stays usable for downloading until the day
    const billing = require('./billing-service');
    try { const a = await billing.getAccount(orgId); if (a && a.state !== 'cancelled') await billing.cancel(orgId, by); } catch (e) { logger.warn(`[CompanyData] billing not cancelled for ${orgId}: ${e.message}`); }
    await sendMail(byEmail, `Your Onn HR account will be deleted on ${c.deleteOn}`, [
        `You asked to close the Onn HR account for ${c.companyName}.`, '',
        `On ${c.deleteOn} we will delete all of its data: people, hours, time off, documents, files and sign-in accounts. This cannot be undone after that day.`, '',
        'Until then:',
        `- Download a copy: ${appUrl()}/admin-us-owner.html#data`,
        `- Changed your mind? Press "Keep my account" on the same page before ${c.deleteOn}.`, '',
        'Billing has stopped. Backups that still hold the data expire within 35 days after deletion.', '',
        'Onn HR by Prompt AI Ethical Solutions USA LLC. Questions: support@promptaiusa.com'
    ].join('\n'));
    return c;
}

async function withdrawClosure(orgId, { by, now = new Date() }) {
    const c = await status(orgId);
    if (!R.canWithdraw(c, R.dayOf(now))) throw Object.assign(new Error('There is no closing to undo'), { statusCode: 409 });
    const patch = { state: 'withdrawn', withdrawnAt: new Date(now).toISOString(), withdrawnBy: by || null };
    await closures().doc(orgId).set(patch, { merge: true });
    const org = await orgRecord(orgId);
    if (org) await org.ref.set({ closure: { state: 'withdrawn', withdrawnAt: patch.withdrawnAt } }, { merge: true });
    await sendMail(c.contactEmail, 'Your Onn HR account will not be deleted', `The closing of the Onn HR account for ${c.companyName} was undone, so nothing will be deleted.\n\nTo start paying again, choose a plan in Billing: ${appUrl()}/admin-us-owner.html#bill\n\nOnn HR by Prompt AI Ethical Solutions USA LLC`);
    return { ...c, ...patch };
}

/** Deletes everything the company has. Returns counts. Never called for a company without a due closure. */
async function deleteCompany(orgId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(orgId || ''))) throw new Error('Invalid company id');
    const { db, admin } = fb();
    const removed = {}; const uids = [];
    const del = async (ref) => { if (typeof db.recursiveDelete === 'function') await db.recursiveDelete(ref); else await ref.delete(); };
    for (const name of R.deletePlan(await dbCollections())) {
        let n = 0;
        for (;;) {
            const batch = [];
            for await (const d of companyDocs(name, orgId)) { if (d.data().orgId === orgId) batch.push(d); if (batch.length >= PAGE) break; }
            if (!batch.length) break;
            for (const d of batch) { if (name === 'users') uids.push(d.id); await del(d.ref); n += 1; }
            if (batch.length < PAGE) break;
        }
        if (n) removed[name] = n;
    }
    const org = await orgRecord(orgId);
    if (org) { await del(org.ref); removed.organizations = 1; }
    let accounts = 0;
    try {
        for (let i = 0; i < uids.length; i += 1000) { const r = await admin.auth().deleteUsers(uids.slice(i, i + 1000)); accounts += r.successCount || 0; }
    } catch (e) { logger.warn(`[CompanyData] sign-in accounts not all removed for ${orgId}: ${e.message}`); }
    const store = require('./file-store');
    const dir = path.join(store.ROOT, orgId);
    let files = 0;
    if (fs.existsSync(dir)) { files = fs.readdirSync(dir).length; fs.rmSync(dir, { recursive: true, force: true }); }
    return { records: Object.values(removed).reduce((a, b) => a + b, 0), collections: Object.keys(removed).length, signInAccounts: accounts, files };
}

/** Daily: reminders, then deletions that are due. */
async function runDue({ today = R.dayOf(new Date()), env = process.env } = {}) {
    const out = { reminded: 0, deleted: 0, skipped: null, errors: [] };
    const snap = await closures().where('state', '==', 'scheduled').get();
    for (const d of snap.docs) {
        const c = d.data(); const orgId = c.orgId || d.id;
        try {
            if (R.dueForReminder(c, today)) {
                await sendMail(c.contactEmail, `Reminder: your Onn HR account will be deleted on ${c.deleteOn}`, `The Onn HR account for ${c.companyName} will be deleted on ${c.deleteOn}, with all of its data.\n\nDownload a copy first: ${appUrl()}/admin-us-owner.html#data\nTo keep the account, press "Keep my account" on the same page before then.\n\nOnn HR by Prompt AI Ethical Solutions USA LLC`);
                await d.ref.set({ reminded: true, remindedAt: new Date().toISOString() }, { merge: true });
                out.reminded += 1;
            }
            if (R.dueForDeletion(c, today)) {
                if (String(env.COMPANY_DELETION || '').toLowerCase() === 'off') { out.skipped = 'COMPANY_DELETION=off'; continue; }
                const counts = await deleteCompany(orgId);
                const deletedAt = new Date().toISOString();
                await d.ref.set({ state: 'deleted', deletedAt, counts, contactEmail: null, requestedBy: null }, { merge: true });
                await sendMail(c.contactEmail, `Confirmation: the Onn HR data of ${c.companyName} has been deleted`, [
                    `This confirms that on ${deletedAt.slice(0, 10)} Prompt AI Ethical Solutions USA LLC deleted the Onn HR account of ${c.companyName} and all of its data:`,
                    `${counts.records} records, ${counts.files} stored files and ${counts.signInAccounts} sign-in accounts.`, '',
                    'Backups that still held the data expire within 35 days. We keep only our invoices to you (for tax records) and this closure record (company name, dates and the counts above).', '',
                    'Thank you for using Onn HR. Questions: support@promptaiusa.com'
                ].join('\n'));
                logger.info(`[CompanyData] company ${orgId} deleted: ${JSON.stringify(counts)}`);
                out.deleted += 1;
            }
        } catch (e) { out.errors.push({ orgId, error: String(e.message || e).slice(0, 200) }); logger.error(`[CompanyData] closure step failed for ${orgId}: ${e.message}`); }
    }
    return out;
}

module.exports = { buildExport, status, requestClosure, withdrawClosure, deleteCompany, runDue, companyName };
