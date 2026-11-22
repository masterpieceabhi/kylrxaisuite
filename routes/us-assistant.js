/**
 * HR assistant for US companies: the owner and HR admins ask questions about their own company in plain English.
 * The server gathers this company's facts (only the fields listed in services/hr-assistant.js), sends them with the
 * question to OpenAI, stores the conversation for that person, and audits each question (its length, not its text).
 *
 *   GET    /api/us/assistant/status     is it switched on, today's use, the headline counts
 *   GET    /api/us/assistant/messages   this person's conversation
 *   POST   /api/us/assistant/ask        { question } -> { answer }
 *   DELETE /api/us/assistant/messages   clears this person's conversation
 */
const express = require('express');
const router = express.Router();
const { admin, db, rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../services/permissions');
const { requireUsOrg, audit, exists, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const timeRules = require('../services/time-rules');
const R = require('../services/us-reports');
const A = require('../services/hr-assistant');
const ai = require('../services/openai-client');
const logger = require('../utils/logger');

const USE = requirePermission('assistant.use');

router.use('/assistant', verifyToken, USE, requireUsOrg);

const threadRef = (orgId, userId) => rawCollection('assistant_threads').doc(`${orgId}_${userId}`);
const usageRef = (orgId, day) => rawCollection('assistant_usage').doc(`${orgId}_${day}`);
const userIdOf = (req) => req.user.id || req.user.uid;

async function today(orgId) {
    const info = await orgInfo(orgId);
    return timeRules.localDate(new Date().toISOString(), info.tz);
}

/** One part of the facts; a part that cannot be read is left out and logged, never breaking the answer */
async function part(name, fn, fallback) {
    try { return await fn(); } catch (e) { logger.error(`HR assistant: ${name} could not be read: ${e.message}`); return fallback; }
}

/** This company's facts, reduced to what the assistant may see */
async function gatherFacts(orgId) {
    const day = await today(orgId);
    const orgSnap = await rawCollection('organizations').doc(orgId).get();
    const org = exists(orgSnap) ? orgSnap.data() : {};
    // sign-up stores Display_Name / Legal_Name / State; older records use other spellings
    const company = { name: org.Display_Name || org.Legal_Name || org.companyName || org.name || null, state: org.State || org.state || null };

    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).where('orgId', '==', orgId).get()));
    const docs = snaps.flatMap((s) => s.docs);
    const departments = await part('departments', async () => new Map((await require('../services/people-data-store').listByOrg('departments', orgId)).map((x) => [x.id, x.name || null])), new Map());
    const byId = new Map(docs.map((d) => [d.id, d.data()]));
    const people = docs.filter((d) => d.data().employeeId).map((d) => R.normalizePerson(d.id, d.data(), departments));

    const paperwork = await part('missing forms', async () => {
        let extra = {};
        try { extra = { training: await require('./us-training').helpers.statusByPerson(orgId) }; } catch (_) { extra = {}; }
        return R.complianceReport(people, day, extra).list;
    }, []);

    const tasks = await part('checklists', async () => {
        const rules = require('../services/checklist-rules');
        const store = require('../services/us-checklist-service');
        const lists = await rawCollection('checklists').where('orgId', '==', orgId).get();
        const read = await store.handbookFacts(orgId).catch(() => () => false);
        const rows = [];
        for (const doc of lists.docs) {
            const c = doc.data();
            if (c.cancelled || !byId.has(c.userId)) continue;
            const ev = rules.evaluate(c.tasks, store.factsFor(byId.get(c.userId), { handbook: read(c.userId) }), day, c.userId);
            ev.tasks.filter((t) => !t.done && !t.skipped).forEach((t) => rows.push({ name: c.name, kind: c.kind, title: t.title, assignee: t.assignee, dueDate: t.dueDate, overdue: t.overdue, required: t.required }));
        }
        return rows.sort((a, b) => (b.overdue - a.overdue) || String(a.dueDate).localeCompare(String(b.dueDate)));
    }, []);

    const leave = await part('time off', async () => (await rawCollection('leave_requests').where('orgId', '==', orgId).get()).docs
        .map((d) => d.data()).filter((r) => r.status === 'pending')
        .map((r) => ({ name: r.name, policyName: r.policyName, startDate: r.startDate, endDate: r.endDate, hours: r.hours })) // never the typed reason
        .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate))), []);

    const weeks = await part('hours', async () => (await rawCollection('timesheet_weeks').where('orgId', '==', orgId).get()).docs
        .map((d) => d.data()).filter((w) => w.status === 'submitted')
        .map((w) => ({ name: w.name, weekStart: w.weekStart, totalHours: w.totals ? w.totals.workedHours : null }))
        .sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart))), []);

    return { today: day, company, people, paperwork, tasks, leave, weeks };
}

/** Counts one question against the company's daily limit; false when the limit is reached */
async function takeQuota(orgId, day, limit) {
    const ref = usageRef(orgId, day);
    return admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const used = exists(snap) ? Number(snap.data().count) || 0 : 0;
        if (used >= limit) return { ok: false, used };
        tx.set(ref, { orgId, day, count: used + 1, updatedAt: new Date().toISOString() }, { merge: true });
        return { ok: true, used: used + 1 };
    });
}

async function usedToday(orgId, day) {
    const snap = await usageRef(orgId, day).get();
    return exists(snap) ? Number(snap.data().count) || 0 : 0;
}

router.get('/assistant/status', async (req, res) => {
    const facts = await gatherFacts(req.orgId);
    const limit = A.dailyLimit(process.env.ASSISTANT_DAILY_LIMIT);
    res.json({
        success: true,
        switchedOn: ai.isConfigured() && limit > 0,
        dailyLimit: limit,
        usedToday: await usedToday(req.orgId, facts.today),
        asOf: facts.today,
        counts: A.overview(facts)
    });
});

router.get('/assistant/messages', async (req, res) => {
    const snap = await threadRef(req.orgId, userIdOf(req)).get();
    res.json({ success: true, messages: exists(snap) ? (snap.data().messages || []) : [] });
});

router.delete('/assistant/messages', async (req, res) => {
    await threadRef(req.orgId, userIdOf(req)).delete();
    audit(req.orgId, req, 'assistant_history_cleared', userIdOf(req));
    res.json({ success: true });
});

router.post('/assistant/ask', async (req, res) => {
    const checked = A.checkQuestion(req.body && req.body.question);
    if (checked.error) return res.status(400).json({ success: false, error: checked.error });
    const limit = A.dailyLimit(process.env.ASSISTANT_DAILY_LIMIT);
    if (!ai.isConfigured() || limit === 0) return res.status(503).json({ success: false, code: 'assistant_off', error: 'The HR assistant is not switched on for this server yet.' });

    const facts = await gatherFacts(req.orgId);
    const quota = await takeQuota(req.orgId, facts.today, limit);
    if (!quota.ok) return res.status(429).json({ success: false, code: 'daily_limit', error: `Your company has used today's ${limit} questions. The assistant opens again tomorrow.` });

    const ref = threadRef(req.orgId, userIdOf(req));
    const snap = await ref.get();
    const stored = exists(snap) ? (snap.data().messages || []) : [];
    const messages = A.buildMessages({ facts: A.buildFacts(facts), history: stored, question: checked.question });

    let reply;
    try {
        reply = await ai.chatText(messages);
    } catch (e) {
        logger.error(`HR assistant: AI call failed: ${e.message}`);
        audit(req.orgId, req, 'assistant_failed', userIdOf(req), { questionLength: checked.question.length, providerStatus: e.providerStatus || null });
        return res.status(e.status === 504 ? 504 : 502).json({ success: false, error: e.status === 504 ? e.message : 'The AI service could not answer just now. Please try again in a minute.' });
    }
    const answer = reply.text || 'I could not write an answer to that. Try asking it another way.';
    const at = new Date().toISOString();
    await ref.set({ orgId: req.orgId, userId: userIdOf(req), updatedAt: at, messages: A.appendTurn(stored, checked.question, answer, at) });
    audit(req.orgId, req, 'assistant_asked', userIdOf(req), {
        questionLength: checked.question.length,
        tokens: reply.usage ? reply.usage.total_tokens || null : null,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    });
    res.json({ success: true, answer, at, usedToday: quota.used, dailyLimit: limit });
});

router.helpers = { gatherFacts };
module.exports = router;
