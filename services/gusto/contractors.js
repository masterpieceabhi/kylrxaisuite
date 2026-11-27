/**
 * Contractors through the payroll provider (US-F07).
 *   - sync: local contractor records (collection `contractors`, W-9 in `contractor_w9`) -> provider contractors
 *   - payments: create (recorded at the provider with method "Check"), list, cancel
 *   - every recorded payment is written to the local 1099 ledger (`contractor_payments`) exactly once: the ledger
 *     row ids are fixed by the provider's payment id, and a row is created only if it does not exist yet
 *
 * The taxpayer ID is decrypted only at the moment it is sent and is never logged or stored by this module.
 * VERIFY against Gusto: every path in this file (contractors, contractors/{id}/address, onboarding_status,
 * contractor_payments) and the bodies built in extras-rules.js.
 */
const crypto = require('crypto');
const X = require('./extras-rules');
const CT = require('../contractor-rules');
const { decryptField } = require('../pii-crypto');
const { GustoError } = require('./client');

const nowIso = () => new Date().toISOString();
const todayOf = (ctx) => (ctx.today ? ctx.today() : new Date().toISOString().slice(0, 10));
const cidOf = (ctx) => { if (!ctx.conn || !ctx.conn.companyUuid) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' }); return ctx.conn.companyUuid; };
const fail = (status, code, message, extra) => Object.assign(new GustoError(message, { status, code }), extra || {});
const errMessage = (e) => (e && e.message ? String(e.message).slice(0, 400) : 'Unknown error');
const tinContext = (orgId, id) => `${orgId}:${id}:contractor-tin`; // same context routes/us-contractors.js encrypts with

/* ------------------------------- our data ------------------------------- */

async function loadContractors(ctx) {
    if (ctx.loadContractors) return ctx.loadContractors(ctx.orgId);
    const { rawCollection } = require('../../config/firebase');
    const [cs, ws] = await Promise.all([rawCollection('contractors').where('orgId', '==', ctx.orgId).get(), rawCollection('contractor_w9').where('orgId', '==', ctx.orgId).get()]);
    const w9 = new Map(ws.docs.map((d) => [d.id, d.data()]));
    return cs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.orgId === ctx.orgId).map((c) => {
        const w = w9.get(c.id);
        return {
            id: c.id, name: c.name, businessName: c.businessName || '', email: c.email || '', active: c.active !== false, createdAt: c.createdAt || null,
            w9: w && w.orgId === ctx.orgId ? { status: w.status, legalName: w.legalName, businessName: w.businessName || '', taxClassification: w.taxClassification, tinType: w.tinType, tinLast4: w.tinLast4 || null, hasTin: Boolean(w.tinEncrypted), tinEncrypted: w.tinEncrypted || null, address: w.address || null } : null
        };
    });
}

/** The 1099 ledger. `create` writes a row only if that id does not exist yet and says whether it wrote. */
function ledgerOf(ctx) {
    if (ctx.ledger) return ctx.ledger;
    const { rawCollection } = require('../../config/firebase');
    const col = rawCollection('contractor_payments');
    const exists = (s) => (typeof s.exists === 'function' ? s.exists() : s.exists);
    return {
        async create(id, doc) {
            try { await col.doc(id).create(doc); return true; } catch (e) {
                if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false;
                throw e;
            }
        },
        async void(id, orgId, patch) {
            const ref = col.doc(id); const s = await ref.get();
            if (!exists(s) || s.data().orgId !== orgId) return false;
            await ref.set(patch, { merge: true });
            return true;
        }
    };
}

/* ------------------------------- sync ------------------------------- */

async function syncContractor(ctx, c) {
    const { orgId, store, client } = ctx;
    if (!c.active) return { status: 'skipped', contractorId: c.id, reason: 'This contractor is inactive.' };
    const problems = X.contractorProblems(c);
    if (problems.length) {
        await store.saveLink(orgId, 'contractor', c.id, { syncState: 'blocked', blockedReasons: problems, name: c.name, lastCheckedAt: nowIso() });
        return { status: 'blocked', contractorId: c.id, reasons: problems };
    }
    try {
        const cid = cidOf(ctx);
        let link = await store.getLink(orgId, 'contractor', c.id);
        const want = X.contractorHash(c);
        if (link && link.gustoUuid && link.hash === want && link.gusto && link.gusto.onboarded) return { status: 'unchanged', contractorId: c.id, gustoUuid: link.gustoUuid, calls: 0 };
        let tin = null;
        if ((!ctx.opts || ctx.opts.sendSsn !== false) && c.w9.tinEncrypted) { try { tin = decryptField(c.w9.tinEncrypted, tinContext(orgId, c.id)); } catch (_) { tin = null; } }
        const body = X.toGustoContractor(c, tin);
        let gustoUuid = link && link.gustoUuid; let calls = 0;
        if (!gustoUuid) {
            const created = await client.post(`/v1/companies/${cid}/contractors`, body, { idempotencyKey: `kylrx:${orgId}:contractor:${c.id}:1` });
            gustoUuid = created.uuid; calls += 1;
            link = await store.saveLink(orgId, 'contractor', c.id, { gustoUuid, version: created.version, syncState: 'pending', name: c.name, blockedReasons: null });
        } else if (link.hash !== want) {
            const { wage_type: _w, self_onboarding: _s, file_new_hire_report: _f, type: _t, ...fields } = body;
            if (link.tinLast4 === c.w9.tinLast4) { delete fields.ssn; delete fields.ein; } // only re-send the taxpayer ID when it changed
            await client.putVersioned(`/v1/contractors/${gustoUuid}`, `/v1/contractors/${gustoUuid}`, () => fields);
            calls += 1;
        }
        const addr = X.toGustoContractorAddress(c.w9.address);
        const r = await client.putVersioned(`/v1/contractors/${gustoUuid}/address`, `/v1/contractors/${gustoUuid}/address`, (cur) => (['street_1', 'city', 'state', 'zip'].every((k) => cur[k] === addr[k]) && (cur.street_2 || '') === addr.street_2 ? null : addr));
        if (r.changed) calls += 1;
        if (!(link.gusto && link.gusto.onboarded)) { await client.put(`/v1/contractors/${gustoUuid}/onboarding_status`, { onboarding_status: 'onboarding_completed' }); calls += 1; }
        await store.saveLink(orgId, 'contractor', c.id, { gustoUuid, hash: want, tinLast4: c.w9.tinLast4 || null, syncState: 'synced', lastError: null, blockedReasons: null, name: c.name, gusto: { onboarded: true }, lastSyncedAt: nowIso() });
        await store.resolveErrors(orgId, 'contractor', c.id);
        return { status: calls ? 'synced' : 'unchanged', contractorId: c.id, gustoUuid, calls };
    } catch (e) {
        await store.saveLink(orgId, 'contractor', c.id, { syncState: 'error', lastError: errMessage(e), lastErrorAt: nowIso(), name: c.name });
        await store.logError(orgId, { scope: 'contractor', ref: c.id, name: c.name, code: e.code || 'error', message: errMessage(e) });
        return { status: 'error', contractorId: c.id, error: errMessage(e), code: e.code || 'error' };
    }
}

async function syncContractors(ctx, { ids = null } = {}) {
    cidOf(ctx);
    const list = (await loadContractors(ctx)).filter((c) => !ids || ids.includes(c.id));
    const results = [];
    for (const c of list) results.push(await syncContractor(ctx, c));
    const count = (s) => results.filter((r) => r.status === s).length;
    return { total: results.length, synced: count('synced'), unchanged: count('unchanged'), blocked: count('blocked'), skipped: count('skipped'), errors: count('error'), results };
}

/** Local contractors with where each stands at the provider */
async function listContractors(ctx) {
    const [list, links] = await Promise.all([loadContractors(ctx), ctx.store.listLinks(ctx.orgId, 'contractor')]);
    const byId = new Map(links.map((l) => [l.ourId, l]));
    return list.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => {
        const l = byId.get(c.id) || {};
        const problems = c.active ? X.contractorProblems(c) : [];
        return { contractorId: c.id, name: c.name, businessName: c.businessName || null, active: c.active, w9: c.w9 && c.w9.status === 'received' ? 'received' : 'missing', tinLast4: (c.w9 && c.w9.tinLast4) || null, inGusto: Boolean(l.gustoUuid && l.gusto && l.gusto.onboarded), syncState: l.gustoUuid ? (l.syncState || 'synced') : (problems.length ? 'blocked' : 'not_sent'), blockedReasons: problems.length ? problems : null, lastError: l.lastError || null, lastSyncedAt: l.lastSyncedAt || null };
    });
}

/* ------------------------------- payments ------------------------------- */

const publicPayment = (r, names) => ({
    id: r.id, contractorId: r.contractorId, contractorName: (names && names.get(r.contractorId)) || r.contractorName || null, date: r.date, amount: (r.wageCents || 0) / 100, reimbursement: (r.reimbursementCents || 0) / 100,
    hours: r.hours || null, rate: r.rate || null, memo: r.memo || '', status: r.status, providerStatus: r.providerStatus || null, mayCancel: r.status === 'recorded' && r.mayCancel !== false,
    inLedger: Boolean(r.ledgerWrittenAt), ledgerProblem: r.ledgerError || null, createdAt: r.createdAt || null, createdBy: r.createdBy || null, cancelledAt: r.cancelledAt || null, lastError: r.lastError || null
});

/** Write the ledger rows of a recorded payment. Safe to call again: existing rows are left alone. */
async function writeLedger(ctx, rec) {
    const ledger = ledgerOf(ctx);
    const rows = X.ledgerRowsFor(rec);
    let written = 0;
    for (const row of rows) {
        const { id, ...fields } = row;
        const check = CT.validatePayment(fields, todayOf(ctx)); // the ledger's own rules decide what a valid row is
        if (check.errors.length) throw fail(500, 'ledger_invalid', `The 1099 ledger did not accept this payment: ${check.errors.join('; ')}`);
        const doc = { ...check.value, orgId: ctx.orgId, contractorId: rec.contractorId, voided: false, createdAt: nowIso(), createdBy: rec.createdBy || null, source: 'gusto', providerPaymentId: rec.gustoUuid, gustoPaymentRecordId: rec.id };
        if (await ledger.create(id, doc)) written += 1;
    }
    return ctx.store.saveRecord('contractorPayments', ctx.orgId, rec.id, { ledgerIds: rows.map((r) => r.id), ledgerWrittenAt: nowIso(), ledgerError: null, ledgerRowsWritten: (rec.ledgerRowsWritten || 0) + written });
}

/** Retry the ledger write of a recorded payment whose first write failed */
async function ensureLedger(ctx, id) {
    const rec = await ctx.store.getRecord('contractorPayments', ctx.orgId, id);
    if (!rec) throw fail(404, 'not_found', 'Contractor payment not found.');
    if (rec.status !== 'recorded') throw fail(409, 'wrong_state', `This payment is "${rec.status}", so it does not belong in the 1099 ledger.`);
    const out = await writeLedger(ctx, rec);
    await ctx.store.resolveErrors(ctx.orgId, 'contractor_ledger', id);
    return publicPayment(out);
}

async function createPayment(ctx, input, { actor } = {}) {
    const cid = cidOf(ctx);
    const { errors, value } = X.validateContractorPayment(input, { today: todayOf(ctx) });
    if (errors.length) throw fail(400, 'validation', errors.join('; '), { errors });
    const contractor = (await loadContractors(ctx)).find((c) => c.id === value.contractorId);
    if (!contractor) throw fail(404, 'not_found', 'Contractor not found.');
    if (!contractor.active) throw fail(409, 'inactive', 'This contractor is inactive.');
    const link = await ctx.store.getLink(ctx.orgId, 'contractor', contractor.id);
    if (!link || !link.gustoUuid || !(link.gusto && link.gusto.onboarded)) throw fail(409, 'not_linked', 'This contractor is not in Gusto yet. Send contractors to Gusto first.');

    // One payment per request id: a second click, a retry or a refresh finds the first one instead of paying twice.
    const id = value.requestId || crypto.randomUUID();
    const base = { contractorId: contractor.id, contractorName: contractor.name, date: value.date, wageCents: value.wageCents, reimbursementCents: value.reimbursementCents, hours: value.hours, rate: value.rate, memo: value.memo };
    const fingerprint = X.hash([base.contractorId, base.date, base.wageCents, base.reimbursementCents]);
    let rec = await ctx.store.getRecord('contractorPayments', ctx.orgId, id);
    if (rec && rec.fingerprint !== fingerprint) throw fail(409, 'request_reused', 'This request id was already used for a different payment.');
    if (rec && ['recorded', 'cancelled', 'cancelling'].includes(rec.status)) return { duplicate: true, payment: publicPayment(rec) };
    if (!rec) {
        const twin = (await ctx.store.listRecords('contractorPayments', ctx.orgId)).find((r) => r.fingerprint === fingerprint && ['recorded', 'sending'].includes(r.status));
        if (twin && (input || {}).allowDuplicate !== true) throw fail(409, 'possible_duplicate', `A payment of the same amount to ${contractor.name} on ${value.date} already exists. Confirm that this is a second payment.`);
        const created = await ctx.store.createRecord('contractorPayments', ctx.orgId, id, { ...base, fingerprint, status: 'sending', createdBy: actor || null });
        if (!created) throw fail(409, 'in_progress', 'This payment is already being recorded. Check the list in a moment.');
    } else if (rec.status === 'failed') {
        // A clear refusal (4xx) is replayed by the provider for the same idempotency key, so the next try needs a new key.
        // After an unclear failure (network, 5xx) the same key is kept: if the first try did go through, it is found, not repeated.
        const claimed = await ctx.store.claimRecord('contractorPayments', ctx.orgId, id, ['failed'], { status: 'sending', attempt: (rec.attempt || 1) + (rec.refused ? 1 : 0) });
        if (!claimed) throw fail(409, 'in_progress', 'This payment is already being recorded. Check the list in a moment.');
    } else throw fail(409, 'in_progress', 'This payment is already being recorded. Check the list in a moment.');

    let paid;
    const attempt = ((await ctx.store.getRecord('contractorPayments', ctx.orgId, id)) || {}).attempt || 1;
    try {
        paid = await ctx.client.post(`/v1/companies/${cid}/contractor_payments`, X.toGustoContractorPayment(value, link.gustoUuid), { idempotencyKey: `kylrx:${ctx.orgId}:cpay:${id}:${attempt}` });
    } catch (e) {
        await ctx.store.saveRecord('contractorPayments', ctx.orgId, id, { status: 'failed', lastError: errMessage(e), attempt, refused: e.status >= 400 && e.status < 500 && e.status !== 429 });
        throw e;
    }
    rec = await ctx.store.saveRecord('contractorPayments', ctx.orgId, id, { status: 'recorded', gustoUuid: paid.uuid, providerStatus: paid.status || null, mayCancel: paid.may_cancel !== false, recordedAt: nowIso(), lastError: null });
    // The payment exists at the provider now. A ledger failure must not look like a failed payment: it is kept as a
    // problem to retry, and the retry cannot double-write.
    try { rec = await writeLedger(ctx, rec); } catch (e) {
        rec = await ctx.store.saveRecord('contractorPayments', ctx.orgId, id, { ledgerError: errMessage(e) });
        try { await ctx.store.logError(ctx.orgId, { scope: 'contractor_ledger', ref: id, name: contractor.name, code: e.code || 'error', message: `The payment was recorded in Gusto but not written to the 1099 ledger: ${errMessage(e)}` }); } catch (_) { /* best effort */ }
    }
    return { duplicate: false, payment: publicPayment(rec) };
}

async function listPayments(ctx, { year = null } = {}) {
    const [rows, list] = await Promise.all([ctx.store.listRecords('contractorPayments', ctx.orgId), loadContractors(ctx)]);
    const names = new Map(list.map((c) => [c.id, c.name]));
    return rows.filter((r) => !year || String(r.date).startsWith(String(year))).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => publicPayment(r, names));
}

async function cancelPayment(ctx, id, { actor, reason } = {}) {
    const cid = cidOf(ctx);
    const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (why.length < 3) throw fail(400, 'validation', 'Say why this payment is cancelled (at least 3 characters).');
    const cur = await ctx.store.getRecord('contractorPayments', ctx.orgId, id);
    if (!cur) throw fail(404, 'not_found', 'Contractor payment not found.');
    const rec = await ctx.store.claimRecord('contractorPayments', ctx.orgId, id, ['recorded'], { status: 'cancelling' });
    if (!rec) throw fail(409, 'wrong_state', `This payment is "${cur.status}" and cannot be cancelled.`);
    try {
        await ctx.client.del(`/v1/companies/${cid}/contractor_payments/${rec.gustoUuid}`);
    } catch (e) {
        if (e.code !== 'not_found') { // not_found: it is already gone at the provider, so finish the cancel here
            await ctx.store.saveRecord('contractorPayments', ctx.orgId, id, { status: 'recorded', lastError: errMessage(e), ...(e.code === 'validation' ? { mayCancel: false } : {}) });
            if (e.code === 'validation') throw fail(409, 'cannot_cancel', `Gusto did not cancel this payment: ${errMessage(e)}`);
            throw e;
        }
    }
    const ledger = ledgerOf(ctx);
    let voided = 0;
    for (const lid of rec.ledgerIds || X.ledgerRowsFor(rec).map((r) => r.id)) if (await ledger.void(lid, ctx.orgId, { voided: true, voidedAt: nowIso(), voidedBy: actor || null, voidReason: `Cancelled at the payroll provider: ${why}` })) voided += 1;
    const out = await ctx.store.saveRecord('contractorPayments', ctx.orgId, id, { status: 'cancelled', cancelledAt: nowIso(), cancelledBy: actor || null, cancelReason: why, ledgerRowsVoided: voided, lastError: null });
    return publicPayment(out);
}

module.exports = { loadContractors, syncContractor, syncContractors, listContractors, createPayment, listPayments, cancelPayment, ensureLedger, tinContext };
