/**
 * Garnishments (US-F11): our record of each order (collection `payroll_garnishments`), sent to the payroll provider
 * as a garnishment on the employee, with a local status and an end.
 *
 * The case number is stored encrypted (services/pii-crypto) and decrypted only to send it or to show it to a reader
 * the route has already checked. Rules and the "no built-in legal limits" note live in services/garnishment-rules.js.
 *
 * VERIFY against Gusto: POST /v1/employees/{id}/garnishments, PUT /v1/garnishments/{id} (with `version`), and that a
 * garnishment is ended by setting active=false (there is no delete).
 */
const crypto = require('crypto');
const G = require('../garnishment-rules');
const sync = require('./sync');
const { encryptField, decryptField } = require('../pii-crypto');
const { GustoError } = require('./client');

const nowIso = () => new Date().toISOString();
const todayOf = (ctx) => (ctx.today ? ctx.today() : new Date().toISOString().slice(0, 10));
const fail = (status, code, message, extra) => Object.assign(new GustoError(message, { status, code }), extra || {});
const errMessage = (e) => (e && e.message ? String(e.message).slice(0, 300) : 'Unknown error');
const caseContext = (orgId, id) => `${orgId}:${id}:garnishment-case`;
const caseOf = (ctx, g) => { try { return g.caseNumberEnc ? decryptField(g.caseNumberEnc, caseContext(ctx.orgId, g.id)) : null; } catch (_) { return null; } };
const view = (ctx, g, showCase) => G.publicGarnishment(g, { today: todayOf(ctx), showCase, caseNumber: showCase ? caseOf(ctx, g) : null });
const COL = 'garnishments';

async function getOne(ctx, id) {
    const g = await ctx.store.getRecord(COL, ctx.orgId, String(id));
    if (!g) throw fail(404, 'not_found', 'Garnishment not found.');
    return g;
}

/** Send (or re-send) the record to the provider. A failure is kept on the record; it never loses the record. */
async function push(ctx, g, { active = true } = {}) {
    const link = await ctx.store.getLink(ctx.orgId, 'employee', g.userId);
    if (!ctx.conn || !ctx.conn.companyUuid) return ctx.store.saveRecord(COL, ctx.orgId, g.id, { provider: { state: 'blocked', reason: 'This company is not connected to Gusto.' } });
    if (!link || !link.gustoUuid) return ctx.store.saveRecord(COL, ctx.orgId, g.id, { provider: { state: 'blocked', reason: 'This person is not in Gusto yet. Send people to Gusto, then send this again.' } });
    const body = G.toGustoGarnishment(g, caseOf(ctx, g), { active });
    const p = g.provider || {};
    try {
        let out;
        if (p.gustoUuid) out = (await ctx.client.putVersioned(`/v1/garnishments/${p.gustoUuid}`, `/v1/garnishments/${p.gustoUuid}`, () => body)).data;
        else out = await ctx.client.post(`/v1/employees/${link.gustoUuid}/garnishments`, body, { idempotencyKey: `kylrx:${ctx.orgId}:garnishment:${g.id}:${p.refused || 0}` });
        await ctx.store.resolveErrors(ctx.orgId, 'garnishment', g.id);
        return ctx.store.saveRecord(COL, ctx.orgId, g.id, { provider: { state: 'sent', gustoUuid: out.uuid, active: out.active !== false, sentAt: nowIso(), error: null, reason: null } });
    } catch (e) {
        // a clear refusal (4xx) is replayed for the same idempotency key, so the next try must use a new one
        const refused = (p.refused || 0) + (!p.gustoUuid && e.status >= 400 && e.status < 500 && e.status !== 429 ? 1 : 0);
        await ctx.store.logError(ctx.orgId, { scope: 'garnishment', ref: g.id, name: g.name || null, code: e.code || 'error', message: errMessage(e) });
        return ctx.store.saveRecord(COL, ctx.orgId, g.id, { provider: { state: p.gustoUuid ? 'sent' : 'error', error: errMessage(e), refused } });
    }
}

async function create(ctx, input, { actor } = {}) {
    const { errors, value, caseNumber } = G.validateGarnishment(input);
    if (errors.length) throw fail(400, 'validation', errors.join('; '), { errors });
    const person = (await sync.loadPeople(ctx)).find((p) => p.id === value.userId);
    if (!person) throw fail(404, 'not_found', 'This person was not found.');
    if (person.classification && person.classification !== 'W2') throw fail(409, 'not_employee', 'Garnishments are for employees. This person is a contractor.');
    const id = crypto.randomUUID();
    await ctx.store.createRecord(COL, ctx.orgId, id, { ...value, name: person.name || null, caseNumberEnc: encryptField(caseNumber, caseContext(ctx.orgId, id)), provider: { state: 'not_sent' }, endedAt: null, createdBy: actor || null });
    let g = await getOne(ctx, id);
    if (G.statusOn(g, todayOf(ctx)) === 'active') g = await push(ctx, g);
    return view(ctx, g, true);
}

async function send(ctx, id) {
    const g = await getOne(ctx, id);
    const st = G.statusOn(g, todayOf(ctx));
    if (st === 'ended') throw fail(409, 'wrong_state', 'This garnishment has ended.');
    if (st === 'scheduled') throw fail(409, 'not_started', `This garnishment starts on ${g.startDate}. Send it on or after that day.`);
    return view(ctx, await push(ctx, g), true);
}

/**
 * End it. An end date today or earlier switches it off at the provider now; a later end date is only recorded
 * (nothing switches it off by itself: the list says when it is due).
 */
async function end(ctx, id, input, { actor } = {}) {
    let g = await getOne(ctx, id);
    const today = todayOf(ctx);
    const { errors, endDate, reason } = G.validateEnd(g, input, today);
    if (errors.length) throw fail(g.endedAt ? 409 : 400, g.endedAt ? 'wrong_state' : 'validation', errors.join('; '), { errors });
    if (endDate > today) {
        g = await ctx.store.saveRecord(COL, ctx.orgId, g.id, { endDate, endReason: reason || null });
        return { planned: true, garnishment: view(ctx, g, true) };
    }
    const p = g.provider || {};
    if (p.state === 'sent' && p.gustoUuid && p.active !== false) {
        // switch it off at the provider first: if that fails nothing is marked as ended here
        const out = await ctx.client.putVersioned(`/v1/garnishments/${p.gustoUuid}`, `/v1/garnishments/${p.gustoUuid}`, (cur) => (cur.active === false ? null : { active: false }));
        g = await ctx.store.saveRecord(COL, ctx.orgId, g.id, { provider: { active: out.data.active !== false } });
    }
    g = await ctx.store.saveRecord(COL, ctx.orgId, g.id, { endDate, endedAt: nowIso(), endedBy: actor || null, endReason: reason || null });
    return { planned: false, garnishment: view(ctx, g, true) };
}

async function list(ctx, { showCase = false, userId = null } = {}) {
    const rows = (await ctx.store.listRecords(COL, ctx.orgId)).filter((g) => !userId || g.userId === userId);
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((g) => view(ctx, g, showCase));
}

module.exports = { create, send, end, list, NOTE: G.NOTE };
