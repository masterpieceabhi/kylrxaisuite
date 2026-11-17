/**
 * Stage 06: documents and compliance. The document vault, e-signature, the policy library, notice texts and workplace
 * postings, Form I-9 status and audit report (with one reverification), EEO, the OSHA log, the paperwork report, the
 * lists the compliance calendar reads, privacy requests, retention jobs, custom fields, tags, emergency contacts,
 * a self-service address change, and the audit log with its integrity check.
 *
 * Uses the company and people of stage 01. It adds one person of its own (for the I-9 reverification and the one
 * deletion that is really run); nobody from stage 01 is terminated, re-paid, re-roled or deleted.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
    id: '06',
    title: 'Documents and compliance',
    covers: ['US-H01', 'US-H02', 'US-H03', 'US-H04', 'US-H05', 'US-H06', 'US-H07', 'US-H08', 'US-B05', 'US-B06', 'US-B07', 'US-L04', 'US-A10'],
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const P = state.people;
        const uniq = `${state.run}-${String(Date.now()).slice(-6)}`;       // names that must differ on a --reuse re-run
        const key = `${state.run}_${String(Date.now()).slice(-6)}`;        // the same, for field keys (letters, digits, underscores)
        const yesterday = ctx.addDays(ctx.today, -1);                      // "not in the future" in the company's own time zone
        const ids = state.ids.documents = state.ids.documents || {};

        const owner = await ctx.as('owner');
        const hr = await ctx.as('hr');
        const manager = await ctx.as('manager');
        const auditor = await ctx.as('auditor');
        const cashier = await ctx.as('cashier');
        const server = await ctx.as('server');
        const stocker = await ctx.as('stocker');

        /** Uploads a file to the vault the way the page does: a multipart form with the file in "file" */
        async function upload(token, fields, fileName, content) {
            const fd = new FormData();
            for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
            fd.append('file', new Blob([content], { type: 'text/plain' }), fileName);
            const res = await fetch(`${ctx.APP}${U}/vault/documents`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
            const text = await res.text(); let b = {};
            try { b = JSON.parse(text); } catch (_) { /* not JSON */ }
            return { s: res.status, b, text };
        }

        // ============================================================================================ document vault
        ctx.section('Document vault');
        const cats = await call('GET', `${U}/vault/categories`, hr);
        check('the vault lists its document categories, each for a person or for the company', cats.s === 200 && (cats.b.data || []).length >= 10 && cats.b.data.every((c) => ['employee', 'company'].includes(c.scope)), cats.text.slice(0, 300));

        const certText = `Food handler certificate for Carlos Diaz, run ${uniq}`;
        const expiresOn = ctx.addDays(ctx.today, 30);
        const up = await upload(hr, { scope: 'employee', category: 'certification', title: `Food handler certificate ${uniq}`, userId: P.cashier.uid, expiresOn, shared: 'true' }, 'food-handler.txt', certText);
        const certId = up.b.document && up.b.document.id;
        check('HR stores a certificate for the cashier with an expiry date', up.s === 201 && certId && up.b.document.expiresOn === expiresOn && up.b.document.shared === true, up.text.slice(0, 300));
        ids.certificateId = certId;

        const noFile = await call('POST', `${U}/vault/documents`, hr, { scope: 'employee', category: 'certification', title: 'No file', userId: P.cashier.uid });
        check('an upload with no file is refused (400)', noFile.s === 400, noFile.b);
        const wrongType = await upload(hr, { scope: 'employee', category: 'certification', title: 'Program', userId: P.cashier.uid }, 'tool.exe', Buffer.from('MZ\x90\x00\x03\x00\x00\x00binary', 'latin1'));
        check('a program file is refused (400)', wrongType.s === 400, wrongType.b);
        const byEmployee = await upload(cashier, { scope: 'employee', category: 'certification', title: 'Mine', userId: P.cashier.uid }, 'mine.txt', 'my own file content here');
        check('an employee cannot store documents in the vault (403)', byEmployee.s === 403, byEmployee.b);

        const mineList = await call('GET', `${U}/vault/documents`, cashier);
        check('the cashier sees their own certificate in their documents', mineList.s === 200 && (mineList.b.data || []).some((d) => d.id === certId), mineList.text.slice(0, 300));
        const mineDown = await call('GET', `${U}/vault/documents/${certId}/download`, cashier);
        check('the cashier downloads it and gets the same file back', mineDown.s === 200 && mineDown.text === certText && /attachment/.test(String(mineDown.headers.get('content-disposition'))), { s: mineDown.s, text: mineDown.text.slice(0, 120) });
        const otherList = await call('GET', `${U}/vault/documents`, server);
        check('another employee does not see the cashier\'s certificate', otherList.s === 200 && !(otherList.b.data || []).some((d) => d.id === certId || d.userId === P.cashier.uid), otherList.text.slice(0, 300));
        check('and cannot download it (403)', (await call('GET', `${U}/vault/documents/${certId}/download`, server)).s === 403);
        check('no token cannot download it (401)', (await call('GET', `${U}/vault/documents/${certId}/download`, null)).s === 401);

        const medical = await upload(hr, { scope: 'employee', category: 'medical_confidential', title: `Doctor note ${uniq}`, userId: P.cashier.uid, shared: 'true' }, 'note.txt', 'Confidential medical note for the local run');
        const medId = medical.b.document && medical.b.document.id;
        check('HR stores a medical note; it is marked confidential and is never shared', medical.s === 201 && medical.b.document.confidential === true && medical.b.document.shared === false, medical.text.slice(0, 300));
        const audList = await call('GET', `${U}/vault/documents?userId=${P.cashier.uid}`, auditor);
        check('the auditor sees the certificate but not the confidential note', audList.s === 200 && (audList.b.data || []).some((d) => d.id === certId) && !(audList.b.data || []).some((d) => d.id === medId), audList.text.slice(0, 300));
        check('the cashier does not see the confidential note in their own list', !((await call('GET', `${U}/vault/documents`, cashier)).b.data || []).some((d) => d.id === medId));

        const expiring = await call('GET', `${U}/vault/expiring?days=60`, hr);
        const expRow = (expiring.b.data || []).find((d) => d.id === certId);
        check('the expiring list shows the certificate with about 30 days left', expiring.s === 200 && expRow && expRow.daysLeft >= 29 && expRow.daysLeft <= 31, expiring.text.slice(0, 300));
        check('the expiring list is not for employees (403)', (await call('GET', `${U}/vault/expiring`, cashier)).s === 403);

        const hold = await call('PUT', `${U}/vault/documents/${certId}`, hr, { legalHold: true });
        const heldDelete = await call('DELETE', `${U}/vault/documents/${certId}`, hr);
        check('a document under a legal hold cannot be deleted (409)', hold.s === 200 && hold.b.document.legalHold === true && heldDelete.s === 409, { hold: hold.b, del: heldDelete.b });
        const kept = await call('DELETE', `${U}/vault/documents/${medId}`, hr);
        check('a document still inside its keep-until date cannot be deleted (409)', kept.s === 409 && /Keep this document until/.test(String(kept.b.error)), kept.b);
        await call('PUT', `${U}/vault/documents/${certId}`, hr, { legalHold: false });
        check('the auditor cannot delete a document (403)', (await call('DELETE', `${U}/vault/documents/${certId}`, auditor)).s === 403);
        const del = await call('DELETE', `${U}/vault/documents/${certId}`, hr);
        const afterDel = await call('GET', `${U}/vault/documents/${certId}/download`, cashier);
        check('with the hold released HR deletes the certificate, and it is gone for the cashier (404)', del.s === 200 && afterDel.s === 404, { del: del.b, after: afterDel.s });

        // ================================================================================================== e-sign
        ctx.section('E-signature');
        const seeded = await call('POST', `${U}/esign/templates/seed-defaults`, hr, {});
        const tpls = await call('GET', `${U}/esign/templates`, hr);
        const handbook = (tpls.b.data || []).find((t) => t.type === 'handbook_ack');
        const nda = (tpls.b.data || []).find((t) => t.type === 'nda');
        check('the starter document templates are in place (offer letter, handbook, NDA, policy)', seeded.s === 200 && tpls.s === 200 && handbook && nda && (tpls.b.data || []).some((t) => t.type === 'offer_letter'), { seeded: seeded.b, count: tpls.b.count });
        check('an employee cannot send a document for signature (403)', (await call('POST', `${U}/esign/requests`, cashier, { templateId: handbook && handbook.id, signerType: 'employee', userId: P.cashier.uid })).s === 403);

        const sent = await call('POST', `${U}/esign/requests`, hr, { templateId: handbook && handbook.id, signerType: 'employee', userId: P.cashier.uid });
        const reqId = sent.b.request && sent.b.request.id;
        check('HR sends the handbook acknowledgement to the cashier', sent.s === 201 && reqId && /^\/sign\.html\?t=sg_/.test(String(sent.b.signUrl)), sent.text.slice(0, 300));
        ids.signRequestId = reqId;
        const twice = await call('POST', `${U}/esign/requests`, hr, { templateId: handbook && handbook.id, signerType: 'employee', userId: P.cashier.uid });
        check('the same document cannot be sent twice while the first is open (409)', twice.s === 409, twice.b);

        const toSign = await call('GET', `${U}/esign/my`, cashier);
        const myRow = (toSign.b.data || []).find((r) => r.id === reqId);
        check('the cashier finds it in their "to sign" list as pending', toSign.s === 200 && myRow && myRow.status === 'pending' && /handbook/i.test(myRow.templateName), toSign.text.slice(0, 300));
        check('another employee does not have it in their list, and cannot get its link (403)', !((await call('GET', `${U}/esign/my`, server)).b.data || []).some((r) => r.id === reqId) && (await call('POST', `${U}/esign/my/${reqId}/link`, server, {})).s === 403);
        const link = await call('POST', `${U}/esign/my/${reqId}/link`, cashier, {});
        const signToken = link.b.signUrl ? new URL(link.b.signUrl, ctx.APP).searchParams.get('t') : null;
        check('the cashier opens their signing link', link.s === 200 && Boolean(signToken), link.b);
        const view = await call('GET', `/api/public/sign/${signToken}`, null);
        check('the signing page shows the document with the cashier\'s name and the company name filled in', view.s === 200 && view.b.signerName === P.cashier.name && String(view.b.html).includes(P.cashier.name) && String(view.b.html).includes(state.company.name) && !/\{\{/.test(String(view.b.html)), view.text.slice(0, 400));
        const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 1)]).toString('base64');
        const wrongName = await call('POST', `/api/public/sign/${signToken}/sign`, null, { consent: true, typedName: 'Somebody Else', signatureData: png });
        check('signing with a different typed name is refused (400)', wrongName.s === 400, wrongName.b);
        const noConsent = await call('POST', `/api/public/sign/${signToken}/sign`, null, { consent: false, typedName: P.cashier.name, signatureData: png });
        check('signing without agreeing to electronic signatures is refused (400)', noConsent.s === 400, noConsent.b);
        const signed = await call('POST', `/api/public/sign/${signToken}/sign`, null, { consent: true, typedName: P.cashier.name, signatureData: png });
        check('the cashier signs with their typed name and a drawn signature', signed.s === 200 && signed.b.signedAt && signed.b.documentHash, signed.b);
        const again = await call('POST', `/api/public/sign/${signToken}/sign`, null, { consent: true, typedName: P.cashier.name, signatureData: png });
        check('the link cannot be used a second time', again.s >= 400 && again.s < 500, { s: again.s, b: again.b });
        const detail = await call('GET', `${U}/esign/requests/${reqId}`, hr);
        check('HR sees the request as signed, with its history (created, viewed, signed)', detail.s === 200 && detail.b.request.status === 'signed' && ['created', 'viewed', 'signed'].every((a) => (detail.b.history || []).some((h) => JSON.stringify(h).includes(a))), detail.text.slice(0, 500));
        const cert = await call('GET', `${U}/esign/requests/${reqId}/certificate`, hr);
        check('the completion certificate downloads and names the signer and the document fingerprint', cert.s === 200 && cert.text.includes(P.cashier.name) && cert.text.includes(String(signed.b.documentHash)), { s: cert.s, text: cert.text.slice(0, 200) });
        const signedDocs = await call('GET', `${U}/vault/documents?userId=${P.cashier.uid}&category=signed_policy`, hr);
        check('the signed document is filed in the cashier\'s vault as a signed acknowledgement', signedDocs.s === 200 && (signedDocs.b.data || []).length >= 1, signedDocs.text.slice(0, 300));
        check('an employee cannot open the certificate or the request list (403)', (await call('GET', `${U}/esign/requests/${reqId}/certificate`, cashier)).s === 403 && (await call('GET', `${U}/esign/requests`, cashier)).s === 403);

        const second = await call('POST', `${U}/esign/requests`, hr, { templateId: nda && nda.id, signerType: 'employee', userId: P.server.uid, expiresInDays: 2 });
        const secondId = second.b.request && second.b.request.id;
        check('HR sends a second document (an NDA) to the server', second.s === 201 && secondId, second.text.slice(0, 300));
        const due = await call('GET', `${U}/esign/reminders`, hr);
        check('the reminder worklist shows it, because its link expires soon', due.s === 200 && (due.b.data || []).some((r) => r.id === secondId && r.expiringSoon === true), due.text.slice(0, 300));
        const remind = await call('POST', `${U}/esign/requests/${secondId}/remind`, hr, {});
        const afterRemind = await call('GET', `${U}/esign/requests/${secondId}`, hr);
        check('HR records a reminder and it shows on the request', remind.s === 200 && (afterRemind.b.history || []).some((h) => /reminder/.test(JSON.stringify(h))), { remind: remind.b, history: afterRemind.b.history });
        const voided = await call('POST', `${U}/esign/requests/${secondId}/void`, hr, { reason: 'Sent to the wrong person' });
        const afterVoid = await call('GET', `${U}/esign/requests/${secondId}`, hr);
        check('HR voids the second request', voided.s === 200 && afterVoid.b.request.status === 'voided', { voided: voided.b, status: afterVoid.b.request && afterVoid.b.request.status });
        check('a voided request gives no signing link (409) and cannot be reminded (409)', (await call('POST', `${U}/esign/my/${secondId}/link`, server, {})).s === 409 && (await call('POST', `${U}/esign/requests/${secondId}/remind`, hr, {})).s === 409);
        ctx.skip('the signing link and the reminder reach the person by email', 'no email is sent by these routes: HR copies the link, and a reminder is only recorded');

        // ========================================================================================== policy library
        ctx.section('Policy library');
        const policyTitle = `Knife safety ${uniq}`;
        const draft = await call('POST', `${U}/policies`, hr, { title: policyTitle, category: 'Safety', body: 'Always cut away from your body and keep knives in the block when not in use.', requireAck: true });
        const pid = draft.b.policy && draft.b.policy.id;
        check('HR writes a policy draft', draft.s === 201 && pid && draft.b.policy.status === 'draft' && draft.b.policy.version === 0, draft.text.slice(0, 300));
        ids.policyId = pid;
        check('a policy with no text is refused (400)', (await call('POST', `${U}/policies`, hr, { title: 'Empty', category: 'Safety', body: '' })).s === 400);
        check('an employee cannot write a policy or see the HR list (403)', (await call('POST', `${U}/policies`, cashier, { title: 'Mine', category: 'Safety', body: 'Twenty characters of text here.' })).s === 403 && (await call('GET', `${U}/policies`, cashier)).s === 403);
        check('the draft is not shown to employees', !((await call('GET', `${U}/policies/mine`, cashier)).b.data || []).some((p) => p.id === pid) && (await call('GET', `${U}/policies/${pid}/read`, cashier)).s === 404);

        const pub1 = await call('POST', `${U}/policies/${pid}/publish`, hr, {});
        check('HR publishes it as version 1', pub1.s === 200 && pub1.b.policy.status === 'published' && pub1.b.policy.version === 1, pub1.text.slice(0, 300));
        const mine1 = await call('GET', `${U}/policies/mine`, cashier);
        const row1 = (mine1.b.data || []).find((p) => p.id === pid);
        check('the cashier is asked to read and confirm it', mine1.s === 200 && row1 && row1.needsAck === true && mine1.b.waiting >= 1, mine1.text.slice(0, 300));
        const read1 = await call('GET', `${U}/policies/${pid}/read`, cashier);
        check('the cashier reads the policy text', read1.s === 200 && /cut away from your body/.test(JSON.stringify(read1.b.policy)), read1.text.slice(0, 300));
        check('confirming a version other than the one shown is refused (409)', (await call('POST', `${U}/policies/${pid}/acknowledge`, cashier, { version: 7 })).s === 409);
        const ack1 = await call('POST', `${U}/policies/${pid}/acknowledge`, cashier, { version: 1 });
        check('the cashier confirms version 1', ack1.s === 201 && ack1.b.version === 1, ack1.b);
        check('confirming the same version twice is refused (409)', (await call('POST', `${U}/policies/${pid}/acknowledge`, cashier, { version: 1 })).s === 409);
        check('the cashier is no longer asked', ((await call('GET', `${U}/policies/mine`, cashier)).b.data || []).find((p) => p.id === pid).needsAck === false);

        const edit2 = await call('PUT', `${U}/policies/${pid}`, hr, { body: 'Always cut away from your body, keep knives in the block when not in use, and wear a cut glove when slicing.', changeNote: 'Cut gloves are now required' });
        const pub2 = await call('POST', `${U}/policies/${pid}/publish`, hr, {});
        check('HR changes the policy and publishes version 2', edit2.s === 200 && pub2.s === 200 && pub2.b.policy.version === 2, { edit: edit2.b, pub: pub2.text.slice(0, 200) });
        check('the new version asks the cashier again', ((await call('GET', `${U}/policies/mine`, cashier)).b.data || []).find((p) => p.id === pid).needsAck === true);
        const ack2 = await call('POST', `${U}/policies/${pid}/acknowledge`, cashier, { version: 2 });
        check('the cashier confirms version 2', ack2.s === 201, ack2.b);
        const edit3 = await call('PUT', `${U}/policies/${pid}`, hr, { body: 'Always cut away from your body, keep knives in the block when not in use, and wear a cut-resistant glove when slicing.', changeNote: 'Wording only' });
        const pub3 = await call('POST', `${U}/policies/${pid}/publish`, hr, { minor: true });
        const mine3 = ((await call('GET', `${U}/policies/mine`, cashier)).b.data || []).find((p) => p.id === pid);
        check('a small-fix publish makes version 3 and does not ask the cashier again', edit3.s === 200 && pub3.s === 200 && pub3.b.policy.version === 3 && mine3 && mine3.needsAck === false, { pub: pub3.text.slice(0, 200), mine: mine3 });
        const acks = await call('GET', `${U}/policies/${pid}/acks`, hr);
        check('the who-has-read list counts the cashier as done and everyone else as waiting', acks.s === 200 && acks.b.report.done === 1 && acks.b.report.waiting >= 9 && (acks.b.all || []).filter((a) => a.userId === P.cashier.uid).length === 2, acks.text.slice(0, 400));
        check('the auditor can read the who-has-read list but cannot publish (403)', (await call('GET', `${U}/policies/${pid}/acks`, auditor)).s === 200 && (await call('POST', `${U}/policies/${pid}/publish`, auditor, {})).s === 403);
        const full = await call('GET', `${U}/policies/${pid}`, hr);
        check('HR sees all three versions, the third marked as a small fix', full.s === 200 && (full.b.policy.versions || []).length === 3 && full.b.policy.versions[2].minor === true, full.text.slice(0, 300));
        const arch = await call('POST', `${U}/policies/${pid}/archive`, hr, {});
        check('HR archives the policy and employees no longer see it', arch.s === 200 && arch.b.policy.status === 'archived' && !((await call('GET', `${U}/policies/mine`, cashier)).b.data || []).some((p) => p.id === pid), arch.b);
        const acksAfter = await call('GET', `${U}/policies/${pid}/acks`, hr);
        check('the confirmations already given are kept after archiving', acksAfter.s === 200 && (acksAfter.b.all || []).length === 2, acksAfter.text.slice(0, 300));

        // ============================================================================ notice texts and postings
        ctx.section('Notice texts and workplace postings');
        const N = `${U}/notice-templates`;
        const lib = await call('GET', N, hr);
        const starters = (lib.b.data || []).map((t) => t.key);
        check('the three federal starting drafts are listed (FMLA, COBRA, Marketplace)', lib.s === 200 && starters.includes('fmla_rights') && starters.length >= 3 && /fmla/i.test(lib.text) && /cobra/i.test(lib.text) && /marketplace/i.test(lib.text), lib.text.slice(0, 300));
        check('a manager and an employee cannot open the notice texts (403), no token is 401', (await call('GET', N, manager)).s === 403 && (await call('GET', N, cashier)).s === 403 && (await call('GET', N, null)).s === 401);
        const fmla = await call('GET', `${N}/fmla_rights`, hr);
        check('a starting draft opens with its text', fmla.s === 200 && String(fmla.b.template.body || '').length > 100, fmla.text.slice(0, 300));
        const untouched = starters.find((k) => k !== 'fmla_rights' && /cobra|marketplace/i.test(k)) || starters[1];
        const untouchedState = await call('GET', `${N}/${untouched}`, hr);
        if (untouchedState.b.template && !untouchedState.b.template.saved && !untouchedState.b.template.version) {
            const early = await call('POST', `${N}/${untouched}/reviewed`, hr, { reviewerName: 'Jordan Lee, Esq.' });
            check('a starting draft the company has not saved as its own cannot be marked reviewed (409)', early.s === 409, early.b);
        }
        const newBody = `${fmla.b.template ? fmla.b.template.body : 'FMLA notice text.'}\n\nQuestions: ask {{hr_contact}} at {{company_name}}. Edited in run ${uniq}.`;
        const savedN = await call('PUT', `${N}/fmla_rights`, hr, { title: fmla.b.template ? fmla.b.template.title : 'FMLA rights', body: newBody, changeNote: 'Added the contact line' });
        check('HR edits the FMLA notice and a new version is saved', savedN.s === 200 && savedN.b.changed === true && savedN.b.template.version >= 1, savedN.text.slice(0, 300));
        const sameN = await call('PUT', `${N}/fmla_rights`, hr, { title: fmla.b.template ? fmla.b.template.title : 'FMLA rights', body: newBody });
        check('saving the same text again makes no new version', sameN.s === 200 && sameN.b.changed === false && sameN.b.template.version === savedN.b.template.version, sameN.text.slice(0, 200));
        check('an unknown fill-in is refused (400)', (await call('PUT', `${N}/fmla_rights`, hr, { title: 'FMLA rights', body: 'This notice uses {{not_a_field}} which does not exist.' })).s === 400);
        const reviewed = await call('POST', `${N}/fmla_rights/reviewed`, hr, { reviewerName: 'Jordan Lee, Esq.', reviewedOn: yesterday, note: 'Reviewed for the local run' });
        check('HR records that an advisor reviewed this version', reviewed.s === 200 && reviewed.b.template.reviewed && reviewed.b.template.reviewed.reviewerName === 'Jordan Lee, Esq.' && reviewed.b.template.reviewed.version === savedN.b.template.version, reviewed.text.slice(0, 400));
        check('a review with no reviewer name is refused (400)', (await call('POST', `${N}/fmla_rights/reviewed`, hr, {})).s === 400);
        const rendered = await call('POST', `${N}/fmla_rights/render`, hr, { userId: P.cashier.uid });
        check('the notice is prepared for the cashier with the company name filled in and no draft banner', rendered.s === 200 && rendered.text.includes(state.company.name) && rendered.b.draft === false && rendered.b.mark === null, rendered.text.slice(0, 400));
        check('the auditor reads the notice texts but cannot edit them (403)', (await call('GET', N, auditor)).s === 200 && (await call('PUT', `${N}/fmla_rights`, auditor, { title: 'x', body: 'y' })).s === 403);

        const postings = await call('GET', `${U}/postings`, hr);
        check('the workplace notice tracker lists the federal notices and a line for Texas', postings.s === 200 && (postings.b.items || []).some((i) => i.key === 'flsa' && i.scope === 'federal') && (postings.b.items || []).some((i) => i.key === 'state_TX'), postings.text.slice(0, 400));
        const posted = await call('PUT', `${U}/postings/flsa`, hr, { postedOn: yesterday, location: 'Break room board, Congress Ave store', nextReviewOn: ctx.addDays(ctx.today, 300) });
        const postingsAfter = await call('GET', `${U}/postings`, hr);
        const flsaRow = (postingsAfter.b.items || []).find((i) => i.key === 'flsa');
        check('HR records that the FLSA notice is posted, and the tracker shows it as posted', posted.s === 200 && flsaRow && flsaRow.status === 'posted' && flsaRow.entry && flsaRow.entry.postedOn === yesterday && postingsAfter.b.counts.posted >= 1, { put: posted.b, row: flsaRow });
        check('a posting with no place is refused (400), an unknown notice is 404', (await call('PUT', `${U}/postings/flsa`, hr, { postedOn: yesterday })).s === 400 && (await call('PUT', `${U}/postings/not_a_notice`, hr, { postedOn: yesterday, location: 'Wall' })).s === 404);
        const attach = await call('PUT', `${U}/postings/fmla/template`, hr, { templateKey: 'fmla_rights' });
        check('the FMLA notice text is attached to the tracked FMLA notice', attach.s === 200 && attach.b.attached === 'fmla_rights', attach.b);
        check('a manager cannot record a posting (403)', (await call('PUT', `${U}/postings/flsa`, manager, { postedOn: yesterday, location: 'Wall' })).s === 403);

        // ============================================================================================== Form I-9
        ctx.section('Form I-9 status, audit report and a reverification');
        const stage1 = ['hr', 'payroll', 'manager', 'accountant', 'auditor', 'executive', 'cashier', 'server', 'stocker', 'leaver'].map((k) => P[k].uid);
        const i9 = await call('GET', `${U}/i9`, hr);
        const i9rows = (i9.b.data || []).filter((r) => stage1.includes(r.id || r.userId));
        check('the I-9 table shows all ten people from signup with nothing left to do', i9.s === 200 && i9rows.length === 10 && i9rows.every((r) => r.next === 'none'), { count: i9rows.length, next: i9rows.map((r) => r.next), sample: JSON.stringify((i9.b.data || [])[0]).slice(0, 300) });
        check('document numbers in the I-9 table are masked', i9.s === 200 && !/P10000\d\d/.test(i9.text), i9.text.slice(0, 200));
        check('an employee and a manager cannot open the I-9 table (403)', (await call('GET', `${U}/i9`, cashier)).s === 403 && (await call('GET', `${U}/i9`, manager)).s === 403);
        const audit9 = await call('GET', `${U}/reports/i9-audit`, hr);
        const a9 = (audit9.b.list || []).filter((r) => stage1.includes(r.id));
        check('the I-9 audit report has both sections on file for all ten, and none needs action', audit9.s === 200 && a9.length === 10 && a9.every((r) => r.section1On && r.section2On && r.status === 'current' && !r.needsAction), { count: a9.length, bad: a9.filter((r) => r.needsAction || !r.section1On || !r.section2On).map((r) => `${r.name}: ${r.findings.join('; ')}`) });
        const a9csv = await call('GET', `${U}/reports/i9-audit?format=csv`, auditor);
        check('the auditor downloads the I-9 audit report as a spreadsheet file', a9csv.s === 200 && /text\/csv/.test(String(a9csv.headers.get('content-type'))) && /Section 1 signed/.test(a9csv.text) && a9csv.text.includes(P.cashier.name), a9csv.text.slice(0, 200));
        check('an employee cannot open the I-9 audit report (403)', (await call('GET', `${U}/reports/i9-audit`, cashier)).s === 403);

        // a person of this stage's own, whose work authorization ends soon, so there is something to reverify
        const xEmail = `rita.${key}@${state.company.domain}`.toLowerCase();
        const xName = { first: 'Rita', last: `Verify${String(Date.now()).slice(-6)}` };
        const made = await call('POST', `${U}/employees`, hr, { firstName: xName.first, lastName: xName.last, email: xEmail, role: 'employee', startDate: yesterday, jobTitle: 'Prep Cook' });
        const x = made.b.employee || {};
        let extra = null;
        ids.extraPerson = null;
        let changed = { s: 0, b: {} };
        if (check('HR adds a new person whose work permit will need checking again', made.s === 201 && x.uid && x.temporaryPassword, made.text.slice(0, 300))) {
            extra = await ctx.signIn(xEmail, x.temporaryPassword);
            changed = await call('POST', '/api/auth/change-password', extra, { currentPassword: x.temporaryPassword, newPassword: state.password });
            if (changed.s === 200) extra = await ctx.signIn(xEmail, state.password);
        }
        if (extra && changed.s === 429) {
            // the password route allows 30 changes per quarter hour for the whole machine, and nothing else is open to a person until they have chosen a password
            ctx.skip('the I-9 reverification and the deletion that is really run', 'the new person could not choose a password: the limit on password changes per quarter hour was used up by other runs on this machine. Run this stage again later');
            extra = null;
        } else if (extra) {
            check('the new person replaces the temporary password', changed.s === 200, changed.b);
            ids.extraPerson = { uid: x.uid, employeeId: x.employeeId, email: xEmail, name: `${xName.first} ${xName.last}` };
            const prof = await call('PUT', `${U}/employees/${x.uid}/profile`, hr, { legalFirstName: xName.first, legalLastName: xName.last, dateOfBirth: '1992-02-20', homeAddress: { line1: '77 Rainey St', city: 'Austin', state: 'TX', zip: '78701' }, workState: 'TX', classification: 'W2', employmentType: 'part_time', payFrequency: 'weekly', payType: 'hourly', payRate: 16, flsaStatus: 'non_exempt', jobTitle: 'Prep Cook', startDate: yesterday, taxpayerIdType: 'SSN', taxpayerId: `533-45-${6000 + Math.floor(Math.random() * 3000)}` }); // a made-up number for the local run
            const permitEnds = ctx.addDays(ctx.today, 40);
            const s1 = await call('PUT', `${U}/employees/${x.uid}/i9/section1`, extra, { citizenshipStatus: 'alien_authorized_to_work', authorizationNumber: 'A123456789', workAuthorizationExpires: permitEnds, signedName: `${xName.first} ${xName.last}`, attestation: true });
            const s2 = await call('PUT', `${U}/employees/${x.uid}/i9/section2`, hr, { listA: { type: 'employment_authorization_document', title: 'Employment Authorization Document', issuingAuthority: 'USCIS', number: 'EAD7654321', expiresOn: permitEnds }, examinedOn: yesterday, examinationMethod: 'in_person', signerName: P.hr.name, signerTitle: 'HR Manager', certification: true });
            check('the new person and HR complete the I-9 with a work permit that ends in 40 days', prof.s === 200 && s1.s === 200 && s2.s === 200, { prof: prof.s === 200 ? 'ok' : prof.b, s1: s1.s === 200 ? 'ok' : s1.b, s2: s2.s === 200 ? 'ok' : s2.b });
            const soon = await call('GET', `${U}/i9?days=90`, hr);
            check('the I-9 table lists that person under work authorization ending soon', soon.s === 200 && (soon.b.expiring || []).some((r) => (r.id || r.userId) === x.uid), JSON.stringify(soon.b.expiring).slice(0, 400));
            const a9b = await call('GET', `${U}/reports/i9-audit`, hr);
            const xRow = (a9b.b.list || []).find((r) => r.id === x.uid);
            check('the I-9 audit report gives the reverify-by date and says it is within 90 days', xRow && xRow.reverifyOn === permitEnds && xRow.findings.some((f) => /expires within 90 days/.test(f)), xRow);
            check('a reverification with no new document is refused (400)', (await call('POST', `${U}/employees/${x.uid}/i9/reverification`, hr, { kind: 'reverification', examinedOn: yesterday })).s === 400);
            const newEnds = ctx.addDays(ctx.today, 700);
            const rev = await call('POST', `${U}/employees/${x.uid}/i9/reverification`, hr, { kind: 'reverification', document: { list: 'A', type: 'employment_authorization_document', title: 'Employment Authorization Document', number: 'EAD9988776', expiresOn: newEnds }, examinedOn: yesterday, examinationMethod: 'in_person', signerName: P.hr.name, signerTitle: 'HR Manager', certification: true });
            check('HR records the new work permit (Supplement B) and the reverify-by date moves out', rev.s === 201 && rev.b.reverifyOn === newEnds, rev.text.slice(0, 400));
            const one = await call('GET', `${U}/employees/${x.uid}/i9`, hr);
            check('the person\'s I-9 shows the reverification, with the document number masked', one.s === 200 && /reverification/.test(one.text) && !one.text.includes('EAD9988776'), one.text.slice(0, 500));
            const soon2 = await call('GET', `${U}/i9?days=90`, hr);
            check('and the person is no longer on the ending-soon list', soon2.s === 200 && !(soon2.b.expiring || []).some((r) => (r.id || r.userId) === x.uid), JSON.stringify(soon2.b.expiring).slice(0, 300));
            check('the person cannot record a reverification on their own I-9 (403)', (await call('POST', `${U}/employees/${x.uid}/i9/reverification`, extra, { kind: 'reverification', examinedOn: yesterday })).s === 403);
        }

        // =================================================================================================== EEO
        ctx.section('EEO self-identification and report');
        const eeoOpt = await call('GET', `${U}/eeo/options`, cashier);
        check('the cashier sees the voluntary EEO choices', eeoOpt.s === 200 && (eeoOpt.b.jobCategories || []).length >= 5 && eeoOpt.b.sex.includes('declined'), eeoOpt.text.slice(0, 200));
        check('an answer without confirming it is voluntary is refused (400)', (await call('PUT', `${U}/eeo/me`, cashier, { sex: 'male', hispanic: 'yes', veteran: 'declined', disability: 'no', races: [] })).s === 400);
        const selfId = await call('PUT', `${U}/eeo/me`, cashier, { voluntaryNoticeAccepted: true, sex: 'male', hispanic: 'yes', veteran: 'not_protected_veteran', disability: 'no', races: [] });
        const eeoMe = await call('GET', `${U}/eeo/me`, cashier);
        check('the cashier answers, and is shown only that they answered, never the answers', selfId.s === 200 && eeoMe.s === 200 && eeoMe.b.answered === true && !/hispanic|veteran|"male"/.test(eeoMe.text), { put: selfId.b, me: eeoMe.b });
        const jobCat = (eeoOpt.b.jobCategories || []).find((c) => /sales/i.test(c.key + c.label)) || (eeoOpt.b.jobCategories || [])[0] || {};
        const setCat = await call('PUT', `${U}/eeo/job-category/${P.cashier.uid}`, hr, { jobCategory: jobCat.key });
        check('HR sets the cashier\'s EEO job category', setCat.s === 200, setCat.b);
        check('a job category that does not exist is refused (400)', (await call('PUT', `${U}/eeo/job-category/${P.cashier.uid}`, hr, { jobCategory: 'astronaut' })).s === 400);
        const eeoRep = await call('GET', `${U}/eeo/report`, hr);
        const catRow = (eeoRep.b.rows || []).find((r) => r.key === jobCat.key || r.label === jobCat.label);
        check('the EEO report counts one Hispanic male in that job category, as totals only', eeoRep.s === 200 && catRow && catRow.cells && catRow.cells.hispanic_male === 1 && catRow.total >= 1, { row: catRow, text: eeoRep.text.slice(0, 300) });
        check('the report says how many people have not answered and who has no job category', eeoRep.s === 200 && eeoRep.b.unanswered >= 9 && (eeoRep.b.missingCategory || []).length >= 9 && !(eeoRep.b.missingCategory || []).some((m) => m.userId === P.cashier.uid), { unanswered: eeoRep.b.unanswered, missing: (eeoRep.b.missingCategory || []).length });
        const eeoCsv = await call('GET', `${U}/eeo/report?format=csv`, hr);
        check('the EEO totals download as a spreadsheet file', eeoCsv.s === 200 && /Job category/.test(eeoCsv.text) && /All categories/.test(eeoCsv.text), eeoCsv.text.slice(0, 200));
        check('the auditor, a manager and an employee cannot open the EEO report (403)', (await call('GET', `${U}/eeo/report`, auditor)).s === 403 && (await call('GET', `${U}/eeo/report`, manager)).s === 403 && (await call('GET', `${U}/eeo/report`, cashier)).s === 403);

        // ================================================================================================== OSHA
        ctx.section('OSHA injury log');
        check('an injury report dated in the future is refused (400)', (await call('POST', `${U}/osha/report`, cashier, { dateOfIncident: ctx.addDays(ctx.today, 5), description: 'Cut my hand', location: 'Deli counter' })).s === 400);
        const incidentDay = ctx.addDays(ctx.today, -2);
        const incident = await call('POST', `${U}/osha/report`, cashier, { dateOfIncident: incidentDay, description: `Cut left hand on the slicer while cleaning it (${uniq})`, location: 'Deli counter, Congress Ave store', bodyPart: 'Left hand', receivedMedicalTreatment: true, missedWork: true });
        const incId = incident.b.id;
        check('the cashier reports an injury', incident.s === 201 && incId, incident.b);
        ids.incidentId = incId;
        const myInc = await call('GET', `${U}/osha/incidents`, cashier);
        check('the cashier sees their own report as "reported"', myInc.s === 200 && (myInc.b.data || []).some((r) => r.id === incId && r.status === 'reported'), myInc.text.slice(0, 300));
        check('another employee does not see it', !((await call('GET', `${U}/osha/incidents`, server)).b.data || []).some((r) => r.id === incId));
        const hrInc = await call('GET', `${U}/osha/incidents`, hr);
        check('HR sees it with the reporter\'s name', hrInc.s === 200 && (hrInc.b.data || []).some((r) => r.id === incId && r.employeeName === P.cashier.name), JSON.stringify((hrInc.b.data || []).find((r) => r.id === incId)).slice(0, 300));
        check('an employee and a manager cannot classify an injury (403)', (await call('PUT', `${U}/osha/incidents/${incId}/classify`, cashier, { classification: 'not_recordable' })).s === 403 && (await call('PUT', `${U}/osha/incidents/${incId}/classify`, manager, { classification: 'not_recordable' })).s === 403);
        check('a days-away case with no days is refused (400)', (await call('PUT', `${U}/osha/incidents/${incId}/classify`, hr, { classification: 'days_away', injuryType: 'injury', daysAway: 0 })).s === 400);
        const classified = await call('PUT', `${U}/osha/incidents/${incId}/classify`, hr, { classification: 'days_away', injuryType: 'injury', daysAway: 3, daysRestricted: 2, jobTitle: 'Cashier' });
        check('HR classifies it as a recordable case with 3 days away from work', classified.s === 200, classified.b);
        const year = incidentDay.slice(0, 4);
        const log = await call('GET', `${U}/osha/log?year=${year}`, hr);
        const logRow = (log.b.data || []).find((r) => /slicer/.test(String(r.description)) && String(r.description).includes(uniq));
        check('the OSHA 300 log has the case with a case number, the name and the days away', log.s === 200 && logRow && logRow.caseNumber && logRow.employeeName === P.cashier.name && logRow.daysAway === 3 && logRow.classification === 'days_away', { row: logRow, count: log.b.count });
        const logCsv = await call('GET', `${U}/osha/log?year=${year}&format=csv`, auditor);
        check('the auditor downloads the log as a spreadsheet file', logCsv.s === 200 && /Case no\./.test(logCsv.text) && logCsv.text.includes(uniq), logCsv.text.slice(0, 200));
        const summary = await call('GET', `${U}/osha/summary?year=${year}&hoursWorked=20000`, hr);
        check('the yearly summary (300A) counts the case and its days away', summary.s === 200 && /entered by you/.test(summary.text) && summary.b.daysAwayCases >= 1 && summary.b.totalRecordable >= 1 && summary.b.totalDaysAway >= 3 && summary.b.tcir > 0, summary.text.slice(0, 500));
        check('an employee cannot open the log or the summary (403)', (await call('GET', `${U}/osha/log`, cashier)).s === 403 && (await call('GET', `${U}/osha/summary`, cashier)).s === 403);

        // ============================================================== paperwork report and the calendar's lists
        ctx.section('Compliance report and the lists the compliance calendar reads');
        const comp = await call('GET', `${U}/reports/compliance`, hr);
        check('the paperwork and data report reads', comp.s === 200 && Array.isArray(comp.b.list), comp.text.slice(0, 300));
        check('nobody from signup is listed for a missing W-4 or I-9', comp.s === 200 && !(comp.b.list || []).filter((r) => stage1.includes(r.id)).some((r) => /W-4|I-9 section|Section [12]/i.test((r.issueText || []).join(' '))), (comp.b.list || []).filter((r) => stage1.includes(r.id)).map((r) => `${r.name}: ${(r.issueText || []).join('; ')}`));
        const compCsv = await call('GET', `${U}/reports/compliance?format=csv`, hr);
        check('it downloads as a spreadsheet file', compCsv.s === 200 && /Problems/.test(compCsv.text), compCsv.text.slice(0, 200));
        check('an employee and a manager cannot open it (403)', (await call('GET', `${U}/reports/compliance`, cashier)).s === 403 && (await call('GET', `${U}/reports/compliance`, manager)).s === 403);
        const calendarLists = ['/reports/i9-audit', '/vault/expiring?days=365', '/hiring/everify/cases', '/hiring/background', '/privacy/requests', '/benefits/cobra', '/benefits/config', '/benefits/events?status=pending', '/esign/requests', '/postings'];
        const cal = [];
        for (const p of calendarLists) cal.push({ p, s: (await call('GET', `${U}${p}`, hr)).s });
        check('every list the compliance calendar page reads answers for HR', cal.every((c) => c.s === 200), cal.filter((c) => c.s !== 200));
        const calAud = [];
        for (const p of ['/reports/i9-audit', '/vault/expiring?days=365', '/esign/requests', '/postings']) calAud.push({ p, s: (await call('GET', `${U}${p}`, auditor)).s });
        check('the auditor gets the lists a read-only role may see, and not the privacy requests (403)', calAud.every((c) => c.s === 200) && (await call('GET', `${U}/privacy/requests`, auditor)).s === 403, calAud);

        // ================================================================================================ privacy
        ctx.section('Privacy requests');
        const types = await call('GET', `${U}/privacy/types`, cashier);
        check('the cashier sees the kinds of privacy request they can make', types.s === 200 && /access/.test(types.text) && /delete/.test(types.text), types.text.slice(0, 200));
        check('a request of an unknown kind is refused (400)', (await call('POST', `${U}/privacy/requests`, cashier, { type: 'everything' })).s === 400);
        check('an employee cannot file a request for somebody else (403)', (await call('POST', `${U}/privacy/requests`, cashier, { type: 'access', onBehalfOf: P.server.uid })).s === 403);
        const access = await call('POST', `${U}/privacy/requests`, cashier, { type: 'access', details: 'Please send me a copy of my data' });
        const accId = access.b.request && access.b.request.id;
        check('the cashier asks for a copy of their data, and gets a due date', access.s === 201 && accId && access.b.request.status === 'received' && access.b.request.dueAt, access.text.slice(0, 300));
        ids.accessRequestId = accId;
        check('a second open request of the same kind is refused (409)', (await call('POST', `${U}/privacy/requests`, cashier, { type: 'access' })).s === 409);
        check('another employee cannot read the request (404), a manager cannot list requests (403)', (await call('GET', `${U}/privacy/requests/${accId}`, server)).s === 404 && (await call('GET', `${U}/privacy/requests`, manager)).s === 403);
        const queue = await call('GET', `${U}/privacy/requests?status=received`, hr);
        check('HR sees the request in the queue', queue.s === 200 && (queue.b.data || []).some((r) => r.id === accId), queue.text.slice(0, 300));
        const started = await call('POST', `${U}/privacy/requests/${accId}/start`, hr, {});
        check('HR starts work on it', started.s === 200 && (await call('GET', `${U}/privacy/requests/${accId}`, hr)).b.request.status === 'in_progress', started.b);
        check('a "copy of my data" request cannot be closed by hand: the export closes it (409)', (await call('POST', `${U}/privacy/requests/${accId}/complete`, hr, { note: 'Done by hand' })).s === 409);
        const exported = await call('POST', `${U}/privacy/requests/${accId}/export`, hr, {});
        check('HR makes the export and the request is completed', exported.s === 200 && exported.b.summary && exported.b.downloadUrl && (await call('GET', `${U}/privacy/requests/${accId}`, hr)).b.request.status === 'completed', exported.text.slice(0, 300));
        const bundle = await call('GET', `${U}/privacy/requests/${accId}/export/download`, cashier);
        check('the cashier downloads the file with their own data', bundle.s === 200 && bundle.b.format === 'kylrx-access-export-v1' && bundle.text.includes(P.cashier.email), bundle.text.slice(0, 300));
        check('the file has no full SSN, no full bank account number and no EEO answers', bundle.s === 200 && !/5\d\d-\d\d-40\d\d/.test(bundle.text) && !/00012345\d{4}/.test(bundle.text) && !/"hispanic":\s*"yes"/.test(bundle.text), (bundle.text.match(/.{40}(5\d\d-\d\d-40\d\d|00012345\d{4}|"hispanic":\s*"yes").{20}/) || [''])[0]);
        const bundleHtml = await call('GET', `${U}/privacy/requests/${accId}/export/download?format=html&lang=es`, hr);
        check('HR can open the same export as a page in Spanish', bundleHtml.s === 200 && /<html|<!doctype/i.test(bundleHtml.text) && /datos/i.test(bundleHtml.text), bundleHtml.text.slice(0, 200));
        check('another employee cannot download it (404)', (await call('GET', `${U}/privacy/requests/${accId}/export/download`, server)).s === 404);
        const mineReq = await call('GET', `${U}/privacy/requests/mine`, cashier);
        check('the cashier sees their request as completed', mineReq.s === 200 && (mineReq.b.data || []).some((r) => r.id === accId && r.status === 'completed'), mineReq.text.slice(0, 300));

        const delReq = await call('POST', `${U}/privacy/requests`, stocker, { type: 'delete', details: 'Please delete what you do not need' });
        const delId = delReq.b.request && delReq.b.request.id;
        check('the stock clerk asks for their data to be deleted', delReq.s === 201 && delId, delReq.text.slice(0, 300));
        check('an employee cannot preview or run a deletion (403)', (await call('POST', `${U}/privacy/requests/${delId}/deletion/preview`, stocker, {})).s === 403 && (await call('POST', `${U}/privacy/requests/${delId}/deletion/execute`, stocker, { acknowledgeIrreversible: true, confirmText: `DELETE ${P.stocker.employeeId}` })).s === 403);
        const preview = await call('POST', `${U}/privacy/requests/${delId}/deletion/preview`, hr, {});
        check('HR previews the deletion: what would go, what must be kept and why', preview.s === 200 && (preview.b.rows || []).length >= 5 && preview.b.employmentActive === true && preview.b.confirmText === `DELETE ${P.stocker.employeeId}` && preview.b.rows.some((r) => r.retainCount > 0 || /retain|keep/i.test(String(r.action))), preview.text.slice(0, 500));
        check('running a deletion without the typed confirmation is refused (400)', (await call('POST', `${U}/privacy/requests/${delId}/deletion/execute`, hr, {})).s === 400);
        check('denying with no real reason is refused (400)', (await call('POST', `${U}/privacy/requests/${delId}/deny`, hr, { reason: 'no' })).s === 400);
        const denied = await call('POST', `${U}/privacy/requests/${delId}/deny`, hr, { reason: 'Payroll and tax records must be kept while employed' });
        const afterDeny = await call('GET', `${U}/privacy/requests/${delId}`, stocker);
        check('HR denies it with a reason, and the stock clerk sees the denial', denied.s === 200 && afterDeny.b.request.status === 'denied' && /Payroll and tax records/.test(afterDeny.text), { denied: denied.b, after: afterDeny.text.slice(0, 300) });
        check('nothing of the stock clerk was deleted: the profile still reads', (await call('GET', `${U}/me/profile`, stocker)).s === 200 && (await call('GET', `${U}/employees/${P.stocker.uid}/forms`, hr)).s === 200);
        const pSummary = await call('GET', `${U}/privacy/summary`, hr);
        check('the privacy summary counts the requests by state', pSummary.s === 200 && pSummary.b.total >= 2 && pSummary.b.byStatus.completed >= 1 && pSummary.b.byStatus.denied >= 1, pSummary.b);

        if (extra && ids.extraPerson) {
            const xDel = await call('POST', `${U}/privacy/requests`, extra, { type: 'delete', details: 'Delete my optional data' });
            const xDelId = xDel.b.request && xDel.b.request.id;
            await call('POST', `${U}/me/emergency-contacts`, extra, { name: 'Rosa Verify', relationship: 'Mother', phone: '512-555-0188' });
            const xPrev = await call('POST', `${U}/privacy/requests/${xDelId}/deletion/preview`, hr, {});
            check('a wrong typed confirmation is refused (400)', (await call('POST', `${U}/privacy/requests/${xDelId}/deletion/execute`, hr, { acknowledgeIrreversible: true, confirmText: 'DELETE nobody' })).s === 400);
            const xRun = await call('POST', `${U}/privacy/requests/${xDelId}/deletion/execute`, hr, { acknowledgeIrreversible: true, confirmText: xPrev.b.confirmText });
            check('for the person this stage added, HR runs a deletion and gets the table of what was deleted and kept', xDel.s === 201 && xPrev.s === 200 && xRun.s === 200 && Array.isArray(xRun.b.table) && xRun.b.table.length >= 5, xRun.text.slice(0, 500));
            const xAfter = await call('GET', `${U}/privacy/requests/${xDelId}`, extra);
            const xContacts = await call('GET', `${U}/me/emergency-contacts`, extra);
            check('that person sees the result, their optional data (emergency contact) is gone and their I-9 is kept', xAfter.b.request && xAfter.b.request.status === 'completed' && xContacts.s === 200 && (xContacts.b.data || []).length === 0 && /reverification/.test((await call('GET', `${U}/employees/${ids.extraPerson.uid}/i9`, hr)).text), { status: xAfter.b.request && xAfter.b.request.status, contacts: xContacts.b });
            check('a deletion cannot be run twice (409)', (await call('POST', `${U}/privacy/requests/${xDelId}/deletion/execute`, hr, { acknowledgeIrreversible: true, confirmText: xPrev.b.confirmText })).s === 409);
        }

        // ============================================================================================== retention
        ctx.section('Retention jobs');
        const jobs = await call('GET', `${U}/retention/jobs`, hr);
        const jobKeys = (jobs.b.data || []).map((j) => j.key);
        check('HR sees the retention jobs (expired vault documents, privacy exports, old logs)', jobs.s === 200 && ['vault_expired_docs', 'privacy_exports'].every((k) => jobKeys.includes(k)), jobs.text.slice(0, 300));
        const dry = await call('POST', `${U}/retention/jobs/vault_expired_docs/run`, hr, {});
        check('a job run as a preview reports what it would delete and deletes nothing', dry.s === 200 && dry.b.result && dry.b.result.dryRun !== false && Number(dry.b.result.affected || 0) === 0, dry.b);
        check('a real run without the typed confirmation is refused (400), an unknown job is 404', (await call('POST', `${U}/retention/jobs/privacy_exports/run`, hr, { dryRun: false })).s === 400 && (await call('POST', `${U}/retention/jobs/nope/run`, hr, {})).s === 404);
        const real = await call('POST', `${U}/retention/jobs/privacy_exports/run`, hr, { dryRun: false, confirm: 'DELETE' });
        const stillThere = await call('GET', `${U}/privacy/requests/${accId}/export/download`, cashier);
        check('the privacy-export job runs for real and leaves today\'s export alone (it has not expired)', real.s === 200 && real.b.result && stillThere.s === 200, { real: real.b, download: stillThere.s });
        check('the auditor and an employee cannot see or run retention jobs (403)', (await call('GET', `${U}/retention/jobs`, auditor)).s === 403 && (await call('POST', `${U}/retention/jobs/privacy_exports/run`, cashier, {})).s === 403);

        // ========================================================================================== custom fields
        ctx.section('Custom fields');
        const plainKey = `locker_${key}`; const secretKey = `allergy_${key}`;
        const plainDef = await call('POST', `${U}/custom-fields`, hr, { key: plainKey, label: `Locker number ${uniq}`, type: 'text', visibility: 'employee_edit' });
        const secretDef = await call('POST', `${U}/custom-fields`, hr, { key: secretKey, label: `Allergy note ${uniq}`, type: 'text', visibility: 'hr_only', sensitive: true });
        check('HR defines a plain field employees fill in and a sensitive field only HR sees', plainDef.s === 201 && secretDef.s === 201 && secretDef.b.field.sensitive === true, { plain: plainDef.b, secret: secretDef.b });
        check('the same field key twice is refused (409), a bad key is refused (400)', (await call('POST', `${U}/custom-fields`, hr, { key: plainKey, label: 'Again', type: 'text' })).s === 409 && (await call('POST', `${U}/custom-fields`, hr, { key: 'Bad Key', label: 'Bad', type: 'text' })).s === 400);
        check('an employee cannot define a field (403)', (await call('POST', `${U}/custom-fields`, cashier, { key: `x_${key}`, label: 'X', type: 'text' })).s === 403);
        const setVals = await call('PUT', `${U}/employees/${P.cashier.uid}/custom-fields`, hr, { values: { [plainKey]: 'A-12', [secretKey]: 'Peanut allergy' } });
        const secretShown = (setVals.b.data || []).find((f) => f.key === secretKey);
        check('HR sets both values; the sensitive one comes back masked', setVals.s === 200 && (setVals.b.data || []).find((f) => f.key === plainKey).value === 'A-12' && secretShown && secretShown.hasValue === true && !/Peanut/.test(setVals.text), setVals.text.slice(0, 400));
        check('revealing the sensitive value needs a reason (400)', (await call('POST', `${U}/employees/${P.cashier.uid}/custom-fields/${secretKey}/reveal`, hr, {})).s === 400);
        const revealed = await call('POST', `${U}/employees/${P.cashier.uid}/custom-fields/${secretKey}/reveal`, hr, { reason: 'Catering order check' });
        check('HR reveals it with a reason', revealed.s === 200 && revealed.b.value === 'Peanut allergy', revealed.b);
        check('the auditor and the cashier cannot reveal it (403)', (await call('POST', `${U}/employees/${P.cashier.uid}/custom-fields/${secretKey}/reveal`, auditor, { reason: 'Audit check' })).s === 403 && (await call('POST', `${U}/employees/${P.cashier.uid}/custom-fields/${secretKey}/reveal`, cashier, { reason: 'It is mine' })).s === 403);
        const ownFields = await call('GET', `${U}/employees/${P.cashier.uid}/custom-fields`, cashier);
        check('the cashier sees the plain field with its value and not the HR-only field', ownFields.s === 200 && (ownFields.b.data || []).some((f) => f.key === plainKey && f.value === 'A-12' && f.canEdit === true) && !(ownFields.b.data || []).some((f) => f.key === secretKey), ownFields.text.slice(0, 400));
        const ownEdit = await call('PUT', `${U}/employees/${P.cashier.uid}/custom-fields`, cashier, { values: { [plainKey]: 'B-07' } });
        const meProfile = await call('GET', `${U}/me/profile`, cashier);
        check('the cashier fills in their own locker number, and it shows on their profile', ownEdit.s === 200 && (meProfile.b.customFields || []).some((f) => f.key === plainKey && f.value === 'B-07'), { edit: ownEdit.b, fields: meProfile.b.customFields });
        check('the cashier cannot set the HR-only field (400)', (await call('PUT', `${U}/employees/${P.cashier.uid}/custom-fields`, cashier, { values: { [secretKey]: 'None' } })).s === 400);
        check('another employee cannot read or change the cashier\'s fields (403)', (await call('GET', `${U}/employees/${P.cashier.uid}/custom-fields`, server)).s === 403 && (await call('PUT', `${U}/employees/${P.cashier.uid}/custom-fields`, server, { values: { [plainKey]: 'Z-99' } })).s === 403);
        const mgrFields = await call('GET', `${U}/employees/${P.cashier.uid}/custom-fields`, manager);
        check('the manager of the cashier does not see the HR-only field', mgrFields.s === 200 && !(mgrFields.b.data || []).some((f) => f.key === secretKey), mgrFields.text.slice(0, 300));
        // switched off again so re-runs do not fill the company's field list; stored values are kept by the app
        const offA = await call('DELETE', `${U}/custom-fields/${plainDef.b.field && plainDef.b.field.id}`, hr);
        const offB = await call('DELETE', `${U}/custom-fields/${secretDef.b.field && secretDef.b.field.id}`, hr);
        check('HR switches both fields off and they leave the cashier\'s profile', offA.s === 200 && offB.s === 200 && !((await call('GET', `${U}/me/profile`, cashier)).b.customFields || []).some((f) => f.key === plainKey), { a: offA.b, b: offB.b });

        // =================================================================================================== tags
        ctx.section('Tags');
        const tagName = `First aid ${uniq.slice(-6)}`; // a tag name is 24 characters at most
        const tag = await call('POST', `${U}/tags`, hr, { name: tagName, color: 'green' });
        const tagId = tag.b.tag && tag.b.tag.id;
        check('HR adds a tag', tag.s === 201 && tagId, tag.b);
        check('the same tag name twice is refused (409)', (await call('POST', `${U}/tags`, hr, { name: tagName.toUpperCase() })).s === 409);
        check('the auditor sees the tag list but cannot add a tag (403); an employee cannot see it (403)', (await call('GET', `${U}/tags`, auditor)).s === 200 && (await call('POST', `${U}/tags`, auditor, { name: `Nope ${uniq}` })).s === 403 && (await call('GET', `${U}/tags`, cashier)).s === 403);
        const tagged = await call('PUT', `${U}/employees/${P.cashier.uid}/tags`, hr, { add: [tagId] });
        check('HR puts the tag on the cashier', tagged.s === 200 && tagged.b.added.length === 1 && tagged.b.data.some((t) => t.id === tagId), tagged.b);
        check('an employee cannot tag anyone (403), an unknown tag is refused (400)', (await call('PUT', `${U}/employees/${P.server.uid}/tags`, cashier, { add: [tagId] })).s === 403 && (await call('PUT', `${U}/employees/${P.cashier.uid}/tags`, hr, { add: ['not-a-tag'] })).s === 400);
        const byTag = await call('GET', `${U}/people/tagged?tag=${tagId}`, hr);
        check('the people list filtered by that tag has exactly the cashier', byTag.s === 200 && byTag.b.count === 1 && byTag.b.data[0].id === P.cashier.uid, byTag.text.slice(0, 300));
        const tagList = await call('GET', `${U}/tags`, hr);
        check('the tag list counts one person with the tag', tagList.s === 200 && (tagList.b.data || []).some((t) => t.id === tagId && t.people === 1), JSON.stringify((tagList.b.data || []).find((t) => t.id === tagId)));
        const delTag = await call('DELETE', `${U}/tags/${tagId}`, hr);
        const afterTag = await call('GET', `${U}/employees/${P.cashier.uid}/tags`, hr);
        check('deleting the tag takes it off the cashier', delTag.s === 200 && delTag.b.removedFromPeople === 1 && afterTag.s === 200 && !(afterTag.b.data || []).some((t) => t.id === tagId), { del: delTag.b, after: afterTag.b });

        // ======================================================= emergency contacts and a self-service change
        ctx.section('Emergency contacts and a change of address');
        for (const c of ((await call('GET', `${U}/me/emergency-contacts`, cashier)).b.data || [])) await call('DELETE', `${U}/me/emergency-contacts/${c.id}`, cashier); // left by an earlier run of this stage
        check('an emergency contact with a bad phone number is refused (400)', (await call('POST', `${U}/me/emergency-contacts`, cashier, { name: 'Elena Diaz', relationship: 'Mother', phone: '12345' })).s === 400);
        const c1 = await call('POST', `${U}/me/emergency-contacts`, cashier, { name: 'Elena Diaz', relationship: 'Mother', phone: '512-555-0142', email: 'elena.diaz@example.com' });
        const c2 = await call('POST', `${U}/me/emergency-contacts`, cashier, { name: 'Marco Diaz', relationship: 'Brother', phone: '(512) 555-0177', isPrimary: true });
        const list2 = c2.b.data || [];
        check('the cashier adds two emergency contacts; exactly one is the main contact', c1.s === 201 && c2.s === 201 && list2.length === 2 && list2.filter((c) => c.isPrimary).length === 1 && list2.find((c) => c.name === 'Marco Diaz').isPrimary === true, c2.b);
        const elena = list2.find((c) => c.name === 'Elena Diaz') || {};
        const c1edit = await call('PUT', `${U}/me/emergency-contacts/${elena.id}`, cashier, { phone: '512-555-0199' });
        check('the cashier corrects a contact\'s phone number', c1edit.s === 200 && (c1edit.b.data || []).find((c) => c.id === elena.id).phone === '(512) 555-0199', c1edit.b);
        const hrContacts = await call('GET', `${U}/employees/${P.cashier.uid}/emergency-contacts`, hr);
        check('HR reads the cashier\'s emergency contacts', hrContacts.s === 200 && (hrContacts.b.data || []).length === 2, hrContacts.b);
        check('another employee and the manager cannot read them (403)', (await call('GET', `${U}/employees/${P.cashier.uid}/emergency-contacts`, server)).s === 403 && (await call('GET', `${U}/employees/${P.cashier.uid}/emergency-contacts`, manager)).s === 403);
        const marco = list2.find((c) => c.name === 'Marco Diaz') || {};
        const c2del = await call('DELETE', `${U}/me/emergency-contacts/${marco.id}`, cashier);
        check('the cashier removes one contact and the other becomes the main contact', c2del.s === 200 && (c2del.b.data || []).length === 1 && c2del.b.data[0].isPrimary === true, c2del.b);

        const pdSettings = await call('GET', `${U}/people-data/settings`, hr);
        const auto = (pdSettings.b.settings && pdSettings.b.settings.profileChange && pdSettings.b.settings.profileChange.autoApprove) || [];
        check('HR reads which profile changes are approved automatically', pdSettings.s === 200 && Array.isArray(auto), pdSettings.b);
        // an address change must wait for HR in this run; the company's own setting is put back afterwards
        if (auto.includes('homeAddress')) await call('PUT', `${U}/people-data/settings`, owner, { profileChange: { autoApprove: auto.filter((f) => f !== 'homeAddress') } });
        for (const r of ((await call('GET', `${U}/me/change-requests`, cashier)).b.data || []).filter((q) => q.status === 'pending')) await call('DELETE', `${U}/me/change-requests/${r.id}`, cashier);
        const newLine = `${String(Date.now()).slice(-4)} Rainey St Apt 5`;
        check('a change request with no reason is refused (400)', (await call('POST', `${U}/me/change-requests`, cashier, { field: 'homeAddress', homeAddress: { line1: newLine, city: 'Austin', state: 'TX', zip: '78701' } })).s === 400);
        const change = await call('POST', `${U}/me/change-requests`, cashier, { field: 'homeAddress', homeAddress: { line1: newLine, city: 'Austin', state: 'TX', zip: '78701' }, reason: 'I moved' });
        const changeId = change.b.request && change.b.request.id;
        check('the cashier asks to change their home address, and it waits for HR', change.s === 201 && changeId && change.b.applied === false && change.b.request.status === 'pending', change.text.slice(0, 300));
        check('the profile still shows the old address while it waits', ((await call('GET', `${U}/me/profile`, cashier)).b.profile.homeAddress || {}).line1 !== newLine);
        check('a second request of the same kind is refused while one waits (409)', (await call('POST', `${U}/me/change-requests`, cashier, { field: 'homeAddress', homeAddress: { line1: '1 Other St', city: 'Austin', state: 'TX', zip: '78701' }, reason: 'Again' })).s === 409);
        check('an employee and a manager cannot open the HR queue or approve (403)', (await call('GET', `${U}/change-requests`, cashier)).s === 403 && (await call('GET', `${U}/change-requests`, manager)).s === 403 && (await call('POST', `${U}/change-requests/${changeId}/approve`, cashier, {})).s === 403);
        const hrQueue = await call('GET', `${U}/change-requests?status=pending`, hr);
        check('HR sees the request with the old and the new address', hrQueue.s === 200 && (hrQueue.b.data || []).some((r) => r.id === changeId && r.after.line1 === newLine && r.before && r.before.line1), hrQueue.text.slice(0, 400));
        check('rejecting needs a reason (400)', (await call('POST', `${U}/change-requests/${changeId}/reject`, hr, {})).s === 400);
        const approved = await call('POST', `${U}/change-requests/${changeId}/approve`, hr, { note: 'Lease seen' });
        check('HR approves it', approved.s === 200 && approved.b.request.status === 'approved', approved.b);
        const after = await call('GET', `${U}/me/profile`, cashier);
        const hrView = await call('GET', `${U}/employees/${P.cashier.uid}/profile`, hr);
        check('the cashier\'s profile now shows the new address, for the cashier and for HR', after.b.profile.homeAddress.line1 === newLine && hrView.text.includes(newLine), { me: after.b.profile.homeAddress, hr: hrView.text.slice(0, 200) });
        check('a request that was decided cannot be decided again (409)', (await call('POST', `${U}/change-requests/${changeId}/approve`, hr, {})).s === 409);
        if (auto.includes('homeAddress')) await call('PUT', `${U}/people-data/settings`, owner, { profileChange: { autoApprove: auto } });

        // ============================================================================================== audit log
        ctx.section('Audit log');
        await sleep(5000); // audit entries are written shortly after each response, one after another
        check('an employee and a manager cannot open the audit log (403), no token is 401', (await call('GET', `${U}/audit`, cashier)).s === 403 && (await call('GET', `${U}/audit`, manager)).s === 403 && (await call('GET', `${U}/audit`, null)).s === 401);
        const expected = [
            ['vault_document_uploaded', medId, 'storing a document'], ['vault_document_downloaded', certId, 'downloading a document'], ['vault_document_deleted', certId, 'deleting a document'],
            ['esign_request_created', reqId, 'sending a document for signature'], ['esign_request_voided', secondId, 'voiding a signature request'], ['esign_certificate_downloaded', reqId, 'downloading a certificate'],
            ['policy_published', pid, 'publishing a policy'], ['policy_acknowledged', pid, 'confirming a policy'], ['policy_archived', pid, 'archiving a policy'],
            ['notice_template_saved', 'fmla_rights', 'editing a notice text'], ['notice_template_reviewed', 'fmla_rights', 'recording a notice review'], ['posting_recorded', 'flsa', 'recording a posting'],
            ['eeo_selfid_submitted', P.cashier.uid, 'an EEO answer'], ['osha_incident_reported', incId, 'reporting an injury'], ['osha_incident_classified', incId, 'classifying an injury'],
            ['privacy_request_created', P.cashier.uid, 'a privacy request'], ['privacy_access_export_generated', P.cashier.uid, 'a privacy export'], ['privacy_deletion_previewed', P.stocker.uid, 'a deletion preview'],
            ['custom_field_revealed', P.cashier.uid, 'revealing a sensitive field'], ['people_tags_changed', P.cashier.uid, 'tagging a person'], ['profile_change_approved', P.cashier.uid, 'approving an address change'],
            ['retention_job_run', 'privacy_exports', 'running a retention job'],
            ...(ids.extraPerson ? [['us_i9_supplement_b_recorded', ids.extraPerson.uid, 'an I-9 reverification'], ['privacy_deletion_executed', ids.extraPerson.uid, 'running a deletion']] : [])
        ];
        const missing = []; let sampleEntry = null; let revealEntry = null;
        for (const [action, target, what] of expected) {
            const r = await call('GET', `${U}/audit?action=${action}&target=${encodeURIComponent(String(target))}&limit=5`, auditor);
            if (!(r.s === 200 && (r.b.data || []).length >= 1)) missing.push(`${what} (${action}, ${r.s})`);
            else { sampleEntry = sampleEntry || r.b.data[0]; if (action === 'custom_field_revealed') revealEntry = r.b.data[0]; }
        }
        check(`the audit log has an entry for each of the ${expected.length} kinds of action taken above`, missing.length === 0, missing);
        check('an audit entry says who did it, when, and carries a chain number', sampleEntry && sampleEntry.actorId && sampleEntry.at && sampleEntry.chained === true && sampleEntry.seq > 0, sampleEntry);
        check('the entry for revealing the sensitive field keeps the reason and not the value', revealEntry && /Catering order check/.test(JSON.stringify(revealEntry)) && !/Peanut/.test(JSON.stringify(revealEntry)), revealEntry);
        const signAudit = await call('GET', `${U}/audit?target=${reqId}&limit=20`, auditor);
        check('the signing itself (opened, signed) is in the audit log although the signer used a link and no sign-in', signAudit.s === 200 && (signAudit.b.data || []).some((e) => /viewed/.test(e.action)) && (signAudit.b.data || []).some((e) => /signed/.test(e.action)), (signAudit.b.data || []).map((e) => e.action));
        const byActor = await call('GET', `${U}/audit?actor=${P.cashier.uid}&action=policy_acknowledged&limit=5`, hr);
        check('HR can search the log by person', byActor.s === 200 && (byActor.b.data || []).length >= 1 && byActor.b.data.every((e) => e.actorId === P.cashier.uid), byActor.text.slice(0, 300));
        const auditCsv = await call('GET', `${U}/audit/export.csv?action=policy_published`, auditor);
        check('the auditor downloads the log as a spreadsheet file', auditCsv.s === 200 && /action_label/.test(auditCsv.text) && auditCsv.text.includes(String(pid)), auditCsv.text.slice(0, 200));
        check('the audit log has no SSN and no revealed value in it', !/5\d\d-\d\d-40\d\d/.test((await call('GET', `${U}/audit?limit=200`, auditor)).text) && !/Peanut allergy/.test((await call('GET', `${U}/audit/export.csv`, auditor)).text));
        await sleep(2000);
        const verify = await call('GET', `${U}/audit/verify`, auditor);
        check('the integrity check of the audit log passes', verify.s === 200 && verify.b.valid === true && verify.b.chained > 0, { valid: verify.b.valid, chained: verify.b.chained, unchained: verify.b.unchained, summary: verify.b.summary, firstBreak: verify.b.firstBreak });
        check('an employee cannot run the integrity check (403)', (await call('GET', `${U}/audit/verify`, cashier)).s === 403);
        ctx.skip('an outside advisor has really reviewed the notice texts and retention periods', 'the app records that a review happened; the review itself is done by a person outside the system');
    }
};
