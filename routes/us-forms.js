const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const { db, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { can, requirePermission } = require('../services/permissions');
const { encryptField, decryptField } = require('../services/pii-crypto');
const forms = require('../services/us-forms');
const i9Rules = require('../services/i9-rules');
const vaultRules = require('../services/vault-rules');
const fileStore = require('../services/file-store');
const { validateDirectDeposit } = require('../services/us-validation');
const { requireUsOrg, findEmployee, audit, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;

// Who may do what on these routes (services/permissions.js decides which roles hold each permission):
//   read a person's W-4, I-9 and bank summary               the person, or people.read (HR, owner, auditor)
//   fill in a W-4, Section 1 or bank details                the person, or people.write
//   the company I-9 list, one person's I-9, paperwork list  compliance.view (HR, owner, auditor)
//   Section 2, Supplement B (reverification, rehire)        compliance.manage, never for your own form
//   store a copy of an I-9 document                         compliance.manage and vault.confidential
//   see a full document number                              pii.reveal, with a reason, written to the audit log
const I9_VIEW = requirePermission('compliance.view');
const I9_MANAGE = requirePermission('compliance.manage');
const PII_REVEAL = requirePermission('pii.reveal');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: vaultRules.MAX_BYTES + 1, files: 1, fields: 8 } });

router.use(verifyToken);

const isSelf = (user, emp) => Boolean(user && user.id) && [emp.id, emp.data.uid, emp.data.userId].filter(Boolean).includes(user.id);
const canRead = (user, emp) => isSelf(user, emp) || can(user, 'people.read');
const canWrite = (user, emp) => isSelf(user, emp) || can(user, 'people.write');

function todayIn(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago' }).format(new Date());
    } catch (_) {
        return new Date().toISOString().slice(0, 10);
    }
}

const orgTimeZone = (org) => (org.usProfile && org.usProfile.timezone) || org.timezone || 'America/Chicago';
const firstDayOf = (emp) => {
    const raw = (emp.data.usProfile && emp.data.usProfile.startDate) || emp.data.joiningDate || '';
    const d = String(raw).slice(0, 10);
    return forms.parseIsoDate(d) ? d : null;
};
const orgOptions = (org) => ({ skipFederalHolidays: Boolean(org.usProfile && org.usProfile.i9SkipFederalHolidays) });

function legalNames(emp) {
    const p = emp.data.usProfile || {};
    const names = [];
    if (p.legalFirstName && p.legalLastName) {
        names.push(`${p.legalFirstName} ${p.legalLastName}`);
        if (p.legalMiddleName) names.push(`${p.legalFirstName} ${p.legalMiddleName} ${p.legalLastName}`);
    }
    if (emp.data.name) names.push(emp.data.name);
    return names;
}

/** Picks the stored legal name the typed signature matches, so the validator can compare exactly */
function expectedName(emp, signed) {
    const names = legalNames(emp);
    const s = String(signed || '').trim().toLowerCase();
    return names.find((n) => n.toLowerCase() === s) || names[0] || '';
}

const publicSection1 = (section1) => {
    if (!section1) return null;
    const { authorizationNumberEncrypted, ...rest } = section1;
    return rest;
};

/** What the screens may see: no encrypted values, document numbers reduced to how they end */
function publicForms(emp, org) {
    const f = emp.data.usForms || {};
    const i9 = f.i9 || {};
    const s1 = publicSection1(i9.section1);
    const s2 = i9Rules.publicSection2(i9.section2);
    const w4 = f.w4 && f.w4.current ? { ...f.w4.current } : null;
    const dd = f.directDeposit ? { bankName: f.directDeposit.bankName, accountType: f.directDeposit.accountType, accountLast4: f.directDeposit.accountLast4, routingNumber: f.directDeposit.routingNumber, updatedAt: f.directDeposit.updatedAt } : null;
    return {
        directDeposit: dd,
        employeeId: emp.data.employeeId || emp.id,
        name: emp.data.name || null,
        firstDay: firstDayOf(emp),
        w4,
        w4Revisions: f.w4 && f.w4.history ? f.w4.history.length : 0,
        i9: { section1: s1, section2: s2 },
        status: forms.onboardingStatus({
            firstDay: firstDayOf(emp), w4: f.w4, i9, todayIso: todayIn(orgTimeZone(org)), options: orgOptions(org)
        })
    };
}

const canAccess = (req, emp) => canWrite(req.user, emp);
const i9Context = (orgId, emp) => `${orgId}:${emp.id}:i9`;

/** Stores a document number encrypted, keeping only how it ends in the clear */
function sealDocument(doc, orgId, emp) {
    const { number, ...rest } = doc;
    return { ...rest, numberEncrypted: encryptField(number, i9Context(orgId, emp)), numberLast4: i9Rules.tailOf(number) };
}

router.get('/employees/:id/forms', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canRead(req.user, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });
    res.json({ success: true, forms: publicForms(emp, req.org) });
});

router.put('/employees/:id/w4', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });

    const { errors, value } = forms.validateW4(req.body, expectedName(emp, req.body && req.body.signedName));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const existing = (emp.data.usForms && emp.data.usForms.w4) || {};
    const history = existing.history || [];
    if (existing.current) history.push(existing.current);
    const current = { ...value, signedAt: new Date().toISOString(), signedById: req.user.id || null, signedIp: req.ip || null };
    await emp.ref.set({ usForms: { w4: { current, history } } }, { merge: true });
    audit(req.orgId, req, 'us_w4_submitted', emp.id, { taxYear: value.taxYear, revision: history.length + 1 });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), w4: { current, history } } } }, req.org) });
});

/** Bank account for direct deposit. The account number is stored encrypted and shown as the last 4 only. */
router.put('/employees/:id/direct-deposit', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const { errors, value } = validateDirectDeposit(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const directDeposit = {
        bankName: value.bankName, routingNumber: value.routingNumber, accountType: value.accountType,
        accountNumberEncrypted: encryptField(value.accountNumber, `${req.orgId}:${emp.id}:bank`), accountLast4: value.accountLast4,
        updatedAt: new Date().toISOString(), updatedBy: req.user.id || null, authorizedAt: new Date().toISOString(), authorizedIp: req.ip || null
    };
    await emp.ref.set({ usForms: { directDeposit } }, { merge: true });
    audit(req.orgId, req, 'us_direct_deposit_updated', emp.id, { bank: value.bankName, last4: value.accountLast4 });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), directDeposit } } }, req.org) });
});

router.put('/employees/:id/i9/section1', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });

    const { errors, value } = forms.validateI9Section1(req.body, expectedName(emp, req.body && req.body.signedName));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const section1 = { ...value, signedAt: new Date().toISOString(), signedById: req.user.id || null, signedIp: req.ip || null };
    if (value.authorizationNumber) {
        section1.authorizationNumberEncrypted = encryptField(value.authorizationNumber, `${req.orgId}:${emp.id}:i9`);
        section1.authorizationNumberLast4 = i9Rules.tailOf(value.authorizationNumber);
        delete section1.authorizationNumber;
    }
    const prev = (emp.data.usForms && emp.data.usForms.i9) || {};
    // A changed Section 1 invalidates an earlier Section 2 sign-off (and the Supplement B entries kept with it).
    // Only HR may keep the earlier Section 2. A new form after a rehire also settles the "new form needed" note.
    const keep = Boolean(req.body.keepSection2) && can(req.user, 'compliance.manage');
    const i9 = { ...prev, section1, section2: prev.section2 && !keep ? null : prev.section2 || null, rehire: prev.rehire && prev.rehire.action === 'new_i9' ? null : prev.rehire || null };
    // update() replaces the whole form: a merge would leave fields of the earlier answer behind (an old expiry date, say)
    await emp.ref.update({ 'usForms.i9': i9 });
    audit(req.orgId, req, 'us_i9_section1_submitted', emp.id, { citizenshipStatus: value.citizenshipStatus });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), i9 } } }, req.org) });
});

router.put('/employees/:id/i9/section2', I9_MANAGE, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (isSelf(req.user, emp)) return res.status(403).json({ success: false, error: 'You cannot complete Section 2 for your own I-9' });

    const prev = (emp.data.usForms && emp.data.usForms.i9) || {};
    if (!prev.section1) return res.status(409).json({ success: false, error: 'The employee must complete Section 1 first' });

    const { errors, value } = forms.validateI9Section2(req.body, firstDayOf(emp));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const section2 = { ...value, signedAt: new Date().toISOString(), signedById: req.user.id || null, signedIp: req.ip || null };
    for (const key of ['listA', 'listB', 'listC']) {
        if (section2[key]) section2[key] = sealDocument({ ...section2[key], title: section2[key].title || i9Rules.titleOf(section2[key].type) }, req.orgId, emp);
    }
    // correcting Section 2 keeps the Supplement B entries already recorded on this form
    if (prev.section2 && Array.isArray(prev.section2.supplementB)) section2.supplementB = prev.section2.supplementB;
    const i9 = { ...prev, section2 };
    // update() replaces the whole section: a merge would keep the documents of an earlier choice next to the new one
    await emp.ref.update({ 'usForms.i9': i9 });
    audit(req.orgId, req, 'us_i9_section2_completed', emp.id, {
        late: value.examinedOn > forms.addBusinessDays(firstDayOf(emp), 3, orgOptions(req.org)), corrected: Boolean(prev.section2)
    });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), i9 } } }, req.org) });
});

/* ---------------------------------- Form I-9 for HR: list, one person, Supplement B, copies, numbers ---------------------------------- */

const isActive = (d) => d.employeeId && !/^terminated$/i.test(String(d.status || ''));

/** What the I-9 screens need to draw their forms: the three document lists as the rules define them */
router.get('/i9/options', I9_VIEW, requireUsOrg, (req, res) => {
    res.json({ success: true, note: i9Rules.ADVISOR_NOTE, lists: i9Rules.documentLists(), supplementKinds: i9Rules.SUPPLEMENT_KINDS, supplementLists: i9Rules.SUPPLEMENT_LISTS, methods: i9Rules.METHODS, maxFileBytes: vaultRules.MAX_BYTES });
});

/** Everyone's I-9 state and deadlines, and whose work authorization ends soon. Document numbers are masked. */
router.get('/i9', I9_VIEW, requireUsOrg, async (req, res) => {
    const today = todayIn(orgTimeZone(req.org));
    const window = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get()));
    const rows = snaps.flatMap((s) => s.docs).filter((d) => d.data().orgId === req.orgId && isActive(d.data())).slice(0, 500)
        .map((d) => { const emp = { id: d.id, data: d.data() }; return i9Rules.listRow(emp, firstDayOf(emp), today, orgOptions(req.org)); })
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json({
        success: true, today, note: i9Rules.ADVISOR_NOTE, window,
        canManage: can(req.user, 'compliance.manage'), canReveal: can(req.user, 'pii.reveal'), canStoreCopies: can(req.user, 'compliance.manage') && can(req.user, 'vault.confidential'),
        me: req.user.id || null, summary: i9Rules.summarize(rows), expiring: i9Rules.upcomingExpiries(rows, window), count: rows.length, data: rows
    });
});

async function copiesFor(orgId, userId) {
    const snap = await rawCollection('vault_documents').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.deleted && d.userId === userId && d.category === i9Rules.COPY_CATEGORY)
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}
const publicCopy = (d) => ({ id: d.id, title: d.title, fileName: d.fileName, mime: d.mime, size: d.size, uploadedAt: d.uploadedAt, retainUntil: d.retainUntil || null, part: (d.i9 && d.i9.part) || null, list: (d.i9 && d.i9.list) || null, supplementId: (d.i9 && d.i9.supplementId) || null });

/** One person's I-9 for HR: both sections, Supplement B entries and the stored copies. Numbers are masked. */
router.get('/employees/:id/i9', I9_VIEW, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const i9 = (emp.data.usForms && emp.data.usForms.i9) || {};
    const copies = await copiesFor(req.orgId, emp.id);
    const seeCopies = can(req.user, 'vault.confidential');
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true, note: i9Rules.ADVISOR_NOTE,
        person: i9Rules.listRow(emp, firstDayOf(emp), todayIn(orgTimeZone(req.org)), orgOptions(req.org)),
        isSelf: isSelf(req.user, emp), section1: publicSection1(i9.section1), section2: i9Rules.publicSection2(i9.section2),
        copies: seeCopies ? copies.map(publicCopy) : [], copyCount: copies.length, copiesHidden: !seeCopies && copies.length > 0
    });
});

/** Supplement B: a new document when work authorization ends, a rehire within three years, or a new name */
router.post('/employees/:id/i9/reverification', I9_MANAGE, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (isSelf(req.user, emp)) return res.status(403).json({ success: false, error: 'You cannot complete Supplement B for your own I-9' });
    const prev = (emp.data.usForms && emp.data.usForms.i9) || {};
    if (!prev.section1 || !prev.section2) return res.status(409).json({ success: false, error: 'Sections 1 and 2 must be complete before Supplement B' });
    const kind = req.body && req.body.kind;
    if (kind === 'rehire' && prev.rehire && prev.rehire.action === 'new_i9') return res.status(409).json({ success: false, error: 'The earlier form is too old to reuse for this rehire. The person needs a new Form I-9.' });
    const earlier = Array.isArray(prev.section2.supplementB) ? prev.section2.supplementB : [];
    if (earlier.length >= i9Rules.MAX_SUPPLEMENTS) return res.status(409).json({ success: false, error: 'This form has no room for more Supplement B entries. Start a new Form I-9.' });

    const { errors, value } = i9Rules.validateSupplementB(req.body, { todayIso: todayIn(orgTimeZone(req.org)) });
    if (errors.length) return res.status(400).json({ success: false, errors });
    const entry = { id: crypto.randomBytes(8).toString('hex'), ...value, recordedAt: new Date().toISOString(), recordedById: req.user.id || null, recordedIp: req.ip || null };
    if (entry.document) entry.document = sealDocument(entry.document, req.orgId, emp);
    const i9 = { ...prev, section2: { ...prev.section2, supplementB: [...earlier, entry] }, rehire: value.kind === 'rehire' ? null : prev.rehire || null };
    await emp.ref.update({ 'usForms.i9': i9 });
    audit(req.orgId, req, 'us_i9_supplement_b_recorded', emp.id, { supplementId: entry.id, kind: value.kind, hasDocument: Boolean(entry.document), expiresOn: entry.document ? entry.document.expiresOn || null : null });
    res.status(201).json({ success: true, supplement: i9Rules.publicSupplement(entry), reverifyOn: forms.reverificationDate(i9.section1, i9.section2) });
});

/** Stores a copy of a document shown for the I-9 in the encrypted document vault, as a confidential file */
router.post('/employees/:id/i9/documents', I9_MANAGE, requireUsOrg, (req, res, next) => {
    if (!can(req.user, 'vault.confidential')) return res.status(403).json({ success: false, error: 'You do not have permission to store confidential documents' });
    upload.single('file')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: 'The file is larger than 10 MB' });
        if (err) return res.status(400).json({ success: false, error: 'Could not read the upload' });
        next();
    });
}, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (isSelf(req.user, emp)) return res.status(403).json({ success: false, error: 'You cannot add documents to your own I-9' });
    const i9 = (emp.data.usForms && emp.data.usForms.i9) || {};
    const meta = i9Rules.validateCopyMeta(req.body);
    // the vault's own checks decide whether the file is acceptable (size, real type, name); only the category differs
    const file = vaultRules.validateUpload({ scope: 'employee', category: 'employee_other', userId: emp.id, title: (meta.value && meta.value.title) || 'Form I-9 document' }, req.file);
    const errors = [...meta.errors, ...file.errors];
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (!i9.section1) return res.status(409).json({ success: false, error: 'The employee must complete Section 1 first' });
    if (meta.value.part === 'supplement' && !((i9.section2 && i9.section2.supplementB) || []).some((s) => s.id === meta.value.supplementId)) return res.status(404).json({ success: false, error: 'Supplement B entry not found' });

    const ref = rawCollection('vault_documents').doc();
    const nowIso = new Date().toISOString();
    const termination = emp.data.usProfile && emp.data.usProfile.termination;
    const doc = {
        orgId: req.orgId, scope: 'employee', category: i9Rules.COPY_CATEGORY, categoryLabel: i9Rules.COPY_CATEGORY_LABEL,
        title: meta.value.title || `Form I-9 document, List ${meta.value.list}`, userId: emp.id, employeeName: emp.data.name || null, expiresOn: null,
        shared: false, confidential: true, mime: file.value.mime, fileName: file.value.fileName, size: req.file.buffer.length,
        sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), uploadedAt: nowIso, uploadedBy: req.user.id || null,
        // kept at least as long as the form itself
        retainUntil: forms.retainUntil(firstDayOf(emp), termination ? termination.lastDay : null), deleted: false, legalHold: false,
        i9: { part: meta.value.part, list: meta.value.list, supplementId: meta.value.supplementId }
    };
    await fileStore.saveFile(req.orgId, ref.id, req.file.buffer);
    try {
        await ref.set(doc);
    } catch (e) {
        await fileStore.removeFile(req.orgId, ref.id).catch(() => {});
        throw e;
    }
    audit(req.orgId, req, 'us_i9_document_copy_stored', emp.id, { documentId: ref.id, part: doc.i9.part, list: doc.i9.list, size: doc.size });
    res.status(201).json({ success: true, document: publicCopy({ id: ref.id, ...doc }) });
});

/** Shows one full document number once, with a stated reason; every reveal is written to the audit log */
router.post('/employees/:id/i9/document-number/reveal', PII_REVEAL, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const reason = String(b.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const found = i9Rules.findNumber((emp.data.usForms && emp.data.usForms.i9) || {}, b.which, String(b.supplementId || ''));
    if (found.error) return res.status(400).json({ success: false, error: found.error });
    if (!found.stored) return res.status(404).json({ success: false, error: 'No document number on file' });
    let plain;
    try {
        plain = decryptField(found.stored, i9Context(req.orgId, emp));
    } catch (e) {
        logger.error(`I-9 document number decrypt failed for ${emp.id}: ${e.message}`);
        return res.status(500).json({ success: false, error: 'Could not decrypt the stored value' });
    }
    await audit(req.orgId, req, 'us_i9_document_number_revealed', emp.id, { reason: reason.slice(0, 200), which: b.which, supplementId: b.which === 'supplement' ? String(b.supplementId) : null });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, which: b.which, number: plain });
});

/** Company-wide view of who is missing or late on W-4 / I-9, plus reverification dates */
router.get('/compliance/onboarding', I9_VIEW, requireUsOrg, async (req, res) => {
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get()));
    const today = todayIn(orgTimeZone(req.org));
    const rows = snaps.flatMap((s) => s.docs)
        .filter((d) => d.data().orgId === req.orgId && d.data().employeeId && !/^terminated$/i.test(String(d.data().status || '')))
        .map((d) => {
            const emp = { id: d.id, data: d.data() };
            const f = forms.onboardingStatus({
                firstDay: firstDayOf(emp), w4: (emp.data.usForms || {}).w4, i9: (emp.data.usForms || {}).i9,
                todayIso: today, options: orgOptions(req.org)
            });
            return { employeeId: emp.data.employeeId, name: emp.data.name || null, firstDay: firstDayOf(emp), ...f };
        });
    const summary = {
        total: rows.length,
        w4Missing: rows.filter((r) => r.w4 === 'missing').length,
        i9Incomplete: rows.filter((r) => r.i9State !== 'complete').length,
        overdue: rows.filter((r) => r.flags.some((x) => x.endsWith('_overdue'))).length,
        reverifySoon: rows.filter((r) => r.flags.includes('i9_reverification_soon')).length
    };
    res.json({ success: true, today, summary, data: rows });
});

router.helpers = { canRead, canWrite, isSelf };
module.exports = router;
