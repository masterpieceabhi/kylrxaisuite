/**
 * Creates US employees (one at a time or from a file). Each person gets a login, a sequential employee ID, and
 * optionally a US profile. The login starts in one of three ways:
 *   - a random temporary password (shown once to the administrator, never stored in readable form); the person must
 *     choose their own password right after the first sign-in (must_change_password, enforced in verifyToken)
 *   - a personal set-up link: no password is shown to anyone; the person chooses one with the link
 *   - a request through the company join link, which HR approves
 * Also here: the links themselves (only a hash of each token is stored), reissuing access, and changing a password.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { admin, db, rawCollection } = require('../config/firebase');
const { runWithTenant } = require('../config/tenant');
const { encryptField } = require('./pii-crypto');
const v = require('./us-validation');
const forms = require('./us-forms');
const checklists = require('./us-checklist-service');
const L = require('./access-link-rules');

const LINKS = 'us_access_links';          // doc id = SHA-256 of the link token; { orgId, kind: 'setup' | 'join', ... }
const JOIN_REQUESTS = 'us_join_requests'; // people who asked to join through a company join link
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();

const ALLOWED_ROLES = ['employee', 'manager', 'hr_admin'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function temporaryPassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '#$%&*+?'];
    const pick = (s) => s[crypto.randomInt(s.length)];
    const chars = [pick(sets[0]), pick(sets[1]), pick(sets[2]), pick(sets[3])];
    const all = sets.join('');
    while (chars.length < 14) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

/** Next sequential employee ID for the organization (EMP0001, EMP0002, ...) */
async function allocateEmployeeIds(orgId, count) {
    const ref = rawCollection('organizations').doc(orgId).collection('counters').doc('employees');
    return admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        const prefix = data.prefix || 'EMP';
        const padLength = Number(data.padLength || 4);
        const start = Number(data.currentSequence || 0);
        const ids = [];
        for (let i = 1; i <= count; i++) ids.push(`${prefix}${String(start + i).padStart(padLength, '0')}`);
        tx.set(ref, {
            currentSequence: start + count, prefix, padLength,
            nextIdPreview: `${prefix}${String(start + count + 1).padStart(padLength, '0')}`,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        return ids;
    });
}

/** Validates the basic person fields; profile fields are validated only when supplied */
function validatePerson(input) {
    const errors = [];
    const b = input || {};
    const value = {
        firstName: String(b.firstName || '').trim(),
        lastName: String(b.lastName || '').trim(),
        email: String(b.email || '').trim().toLowerCase(),
        phone: String(b.phone || '').trim(),
        role: String(b.role || 'employee').trim().toLowerCase(),
        startDate: String(b.startDate || '').trim(),
        jobTitle: String(b.jobTitle || '').trim(),
        department: String(b.department || '').trim()
    };
    if (!value.firstName) errors.push('firstName is required');
    if (!value.lastName) errors.push('lastName is required');
    if (!EMAIL.test(value.email)) errors.push('email is not valid');
    if (!ALLOWED_ROLES.includes(value.role)) errors.push(`role must be one of: ${ALLOWED_ROLES.join(', ')}`);
    if (!forms.parseIsoDate(value.startDate)) errors.push('startDate must be a real date (YYYY-MM-DD)');

    let profile = null;
    let taxpayerId = null;
    if (b.profile && Object.keys(b.profile).length) {
        const p = { legalFirstName: value.firstName, legalLastName: value.lastName, ...b.profile };
        const r = v.validateEmployeeProfile(p);
        errors.push(...r.errors);
        profile = r.value;
        if (b.profile.taxpayerId) {
            const t = v.validateTaxpayerId(b.profile.taxpayerId, b.profile.taxpayerIdType);
            if (!t.valid) errors.push(t.error); else taxpayerId = t;
        }
    }
    return { errors, value, profile, taxpayerId };
}

/** Is this email already somebody's login, in any company? */
async function emailTaken(email) {
    const q = await rawCollection('users').where('email', '==', email).limit(1).get();
    if (!q.empty) return true;
    try {
        await admin.auth().getUserByEmail(email);
        return true;
    } catch (_) {
        return false;
    }
}

/** A password nobody knows, for a login that is opened later with a set-up link */
const unusablePassword = () => `${crypto.randomBytes(32).toString('base64url')}aA1#`;

/**
 * Creates the login, the person record and the optional profile. Throws on failure.
 *   options.access  'password' (default): temporary password, returned once as temporaryPassword
 *                   'link': no password for anyone; the caller makes a set-up link with createSetupLink()
 *   options.existing { uid, passwordHash }: the login already exists (a join request); it is switched on
 * validated may also carry partialProfile (profile pieces from an import), taxpayerId and employeeNumber.
 */
async function createPerson(orgId, validated, employeeId, actorId, options = {}) {
    const { value, profile } = validated;
    const taxpayerId = validated.taxpayerId || null;
    const existing = options.existing || null;
    const byLink = options.access === 'link';
    const password = existing ? null : (byLink ? unusablePassword() : temporaryPassword());
    const name = `${value.firstName} ${value.lastName}`;
    let uid;
    if (existing) {
        uid = existing.uid;
        await admin.auth().updateUser(uid, { displayName: name, disabled: false });
    } else {
        uid = (await admin.auth().createUser({ email: value.email, password, displayName: name, emailVerified: false, disabled: false })).uid;
    }
    try {
        await admin.auth().setCustomUserClaims(uid, { role: value.role, orgId });
        const record = {
            uid, id: uid, orgId, employeeId, name, email: value.email,
            phone: value.phone, role: value.role, status: 'Active', jobTitle: value.jobTitle,
            departmentName: value.department, joiningDate: value.startDate,
            password: existing ? existing.passwordHash : (byLink ? null : await bcrypt.hash(password, 10)),
            must_change_password: !existing && !byLink, is_temporary_password: !existing && !byLink,
            setup_pending: byLink, invite_status: existing ? 'accepted' : 'pending',
            createdAt: nowIso(), createdBy: actorId || null
        };
        if (existing) record.joinedBy = 'join_link';
        if (validated.employeeNumber) record.previousEmployeeNumber = String(validated.employeeNumber).slice(0, 60);
        const partial = !profile && validated.partialProfile ? validated.partialProfile : null;
        if (profile || partial || taxpayerId) {
            record.usProfile = {
                ...(profile || { legalFirstName: value.firstName, legalLastName: value.lastName, ...(partial || {}) }),
                startDate: value.startDate,
                taxpayerIdEncrypted: taxpayerId ? encryptField(taxpayerId.digits, `${orgId}:${uid}`) : null,
                taxpayerIdLast4: taxpayerId ? taxpayerId.last4 : null,
                updatedAt: nowIso(), updatedBy: actorId || null
            };
            if (!profile) record.usProfile.importedIncomplete = true; // pieces from an import; HR and the person finish it
        }
        await db.collection('users').doc(uid).set(record);
        // Start the new-hire checklist (best effort: HR can still add it later)
        try {
            await checklists.createChecklist(orgId, { id: uid, data: record }, 'onboarding', value.startDate);
        } catch (_) {}
    } catch (error) {
        if (existing) await admin.auth().updateUser(uid, { disabled: true }).catch(() => {});
        else await admin.auth().deleteUser(uid).catch(() => {});
        throw error;
    }
    const out = { uid, employeeId, name, email: value.email, role: value.role };
    if (!existing && !byLink) out.temporaryPassword = password;
    return out;
}

// ------------------------------------------------------------------------------------------------ set-up links

/** Every link of this kind for the organization (and person), newest first */
async function linksFor(orgId, kind, uid) {
    const q = uid ? rawCollection(LINKS).where('uid', '==', uid) : rawCollection(LINKS).where('orgId', '==', orgId);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() })).filter((l) => l.data.orgId === orgId && l.data.kind === kind)
        .sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt)));
}

/** Stops every open set-up link of a person. Returns how many were stopped. */
async function revokeSetupLinks(orgId, uid, actorId) {
    const open = (await linksFor(orgId, 'setup', uid)).filter((l) => L.linkState(l.data) === 'active');
    await Promise.all(open.map((l) => l.ref.set({ revokedAt: nowIso(), revokedBy: actorId || null }, { merge: true })));
    return open.length;
}

/** A new personal set-up link (7 days, one use). Earlier links of the person stop working. The token is returned once. */
async function createSetupLink(orgId, uid, actorId) {
    await revokeSetupLinks(orgId, uid, actorId);
    const { token, hash } = L.newToken();
    const { expiresAt } = L.expiryFor('setup');
    await rawCollection(LINKS).doc(hash).set({ orgId, kind: 'setup', uid, createdAt: nowIso(), createdBy: actorId || null, expiresAt, usedAt: null, revokedAt: null });
    return { token, expiresAt };
}

/** The stored link for a token, only while it works. Anything else (wrong, used, revoked, expired) is null. */
async function findActiveLink(token, kind) {
    if (!L.tokenLooksRight(token)) return null;
    const snap = await rawCollection(LINKS).doc(L.hashToken(token)).get();
    if (!exists(snap)) return null;
    const data = snap.data();
    if (data.kind !== kind || L.linkState(data) !== 'active') return null;
    return { id: snap.id, ref: snap.ref, data };
}

async function orgName(orgId) {
    try {
        const snap = await rawCollection('organizations').doc(orgId).get();
        const o = exists(snap) ? snap.data() : {};
        return o.displayName || o.name || o.companyName || o.legalName || (o.usProfile && o.usProfile.legalName) || 'your company';
    } catch (_) { return 'your company'; }
}

/** What the set-up page may show for a working link: the person's first name, sign-in email and company */
async function setupInfo(token) {
    const link = await findActiveLink(token, 'setup');
    if (!link) return null;
    const snap = await rawCollection('users').doc(link.data.uid).get();
    if (!exists(snap) || snap.data().orgId !== link.data.orgId || /^terminated$/i.test(String(snap.data().status || ''))) return null;
    const u = snap.data();
    return { link, user: u, info: { firstName: String(u.name || '').split(' ')[0], email: u.email, company: await orgName(link.data.orgId), expiresAt: link.data.expiresAt } };
}

/** Stores a new password for a person in both places a sign-in checks (Firebase Auth and the server's own hash) */
async function storePassword(uid, password, extra = {}) {
    await admin.auth().updateUser(uid, { password, disabled: false });
    await rawCollection('users').doc(uid).set({
        password: await bcrypt.hash(password, 10), must_change_password: false, is_temporary_password: false, setup_pending: false,
        invite_status: 'accepted', passwordChangedAt: nowIso(), loginAttempts: 0, lockUntil: null, ...extra
    }, { merge: true });
}

const DEAD_LINK = 'This link does not work any more. Ask HR for a new one.';

/**
 * The person chooses their password with their set-up link. The link is used up in a transaction first, so two
 * requests with the same link cannot both win.
 */
async function completeSetup(token, password) {
    const found = await setupInfo(token);
    if (!found) return { ok: false, status: 404, error: DEAD_LINK };
    const problem = L.passwordProblem(password, { email: found.user.email });
    if (problem) return { ok: false, status: 400, error: problem };
    // This request has no signed-in user, so it runs as the link's own company (config/tenant.js would otherwise hide the
    // link from the transaction, or stamp the wrong company on it)
    const linkOrg = found.link.data.orgId;
    const won = await runWithTenant(linkOrg, () => admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(found.link.ref);
        if (!snap.exists || L.linkState(snap.data()) !== 'active') return false;
        tx.set(found.link.ref, { usedAt: nowIso(), orgId: linkOrg }, { merge: true });
        return true;
    }));
    if (!won) return { ok: false, status: 404, error: DEAD_LINK };
    try {
        await storePassword(found.link.data.uid, password);
    } catch (error) {
        await found.link.ref.set({ usedAt: null }, { merge: true }).catch(() => {}); // the person can try again
        throw error;
    }
    return { ok: true, orgId: found.link.data.orgId, uid: found.link.data.uid, email: found.user.email };
}

/** A password nobody knows, for an account whose owner signs in with a PIN, a code or a QR instead. */
const unknownPassword = () => `${crypto.randomBytes(36).toString('base64url')}aA1!`;

/**
 * The person opens their personal set-up link and chooses a PIN (not a password). The link is used up and the answer
 * carries a sign-in token so they go straight in, and a grant the page uses to have this device remembered at
 * /api/auth/pin/remember (the link itself proved who they are, as a code by email would). Any password the account had
 * is replaced by one nobody knows.
 */
async function completeSetupWithPin(token, pin) {
    const found = await setupInfo(token);
    if (!found) return { ok: false, status: 404, error: DEAD_LINK };
    const problem = require('./pin-signin').weakPin(pin);
    if (problem) return { ok: false, status: 400, error: problem };
    const linkOrg = found.link.data.orgId;
    const won = await runWithTenant(linkOrg, () => admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(found.link.ref);
        if (!snap.exists || L.linkState(snap.data()) !== 'active') return false;
        tx.set(found.link.ref, { usedAt: nowIso(), orgId: linkOrg }, { merge: true });
        return true;
    }));
    if (!won) return { ok: false, status: 404, error: DEAD_LINK };
    const uid = found.link.data.uid;
    try {
        await storePassword(uid, unknownPassword(), { pinHash: await bcrypt.hash(String(pin), 10), pinAttempts: 0, pinLockedUntil: null, pinSetAt: nowIso() });
        return {
            ok: true, orgId: linkOrg, uid, email: found.user.email, signinToken: await admin.auth().createCustomToken(uid),
            deviceGrant: require('./pin-signin').deviceGrant(process.env.JWT_SECRET, uid, found.user.email)
        };
    } catch (error) {
        await found.link.ref.set({ usedAt: null }, { merge: true }).catch(() => {}); // the person can try again
        throw error;
    }
}

/**
 * HR gives a person a new way in. Whatever they had before stops working: open set-up links are revoked, the old
 * password is replaced, and their sessions are ended.
 *   method 'link'      a new set-up link; no password exists until the person chooses one
 *   method 'password'  a new temporary password, shown once; the person must change it at the next sign-in
 */
async function reissueAccess(orgId, uid, method, actorId) {
    await revokeSetupLinks(orgId, uid, actorId);
    const ref = rawCollection('users').doc(uid);
    const stamp = { loginAttempts: 0, lockUntil: null, invite_status: 'pending', accessReissuedAt: nowIso(), accessReissuedBy: actorId || null };
    const out = { method };
    if (method === 'password') {
        const password = temporaryPassword();
        await admin.auth().updateUser(uid, { password, disabled: false });
        await ref.set({ password: await bcrypt.hash(password, 10), must_change_password: true, is_temporary_password: true, setup_pending: false, ...stamp }, { merge: true });
        out.temporaryPassword = password;
    } else {
        await admin.auth().updateUser(uid, { password: unusablePassword(), disabled: false });
        await ref.set({ password: null, must_change_password: false, is_temporary_password: false, setup_pending: true, ...stamp }, { merge: true });
        Object.assign(out, await createSetupLink(orgId, uid, actorId));
    }
    await admin.auth().revokeRefreshTokens(uid).catch(() => {});
    await ref.set(require('./session-cutoff').stamp(), { merge: true }); // the token already in hand stops working too
    return out;
}

/**
 * A signed-in person changes their own password. The current password is asked for again whenever the server holds a
 * hash to check it against, so a stolen session alone cannot take the account over.
 */
async function changeOwnPassword(uid, currentPassword, newPassword) {
    const ref = rawCollection('users').doc(uid);
    const snap = await ref.get();
    if (!exists(snap)) return { ok: false, status: 404, error: 'Account not found' };
    const u = snap.data();
    const hash = typeof u.password === 'string' && u.password.startsWith('$2') ? u.password : null;
    if (hash) {
        if (!currentPassword || !(await bcrypt.compare(String(currentPassword), hash))) return { ok: false, status: 400, error: 'The current password is not right' };
        if (await bcrypt.compare(String(newPassword || ''), hash)) return { ok: false, status: 400, error: 'Choose a password that is different from the current one' };
    }
    const problem = L.passwordProblem(newPassword, { email: u.email });
    if (problem) return { ok: false, status: 400, error: problem };
    try {
        await storePassword(uid, newPassword);
    } catch (error) {
        if (error && error.code === 'auth/user-not-found') {
            await ref.set({ password: await bcrypt.hash(newPassword, 10), must_change_password: false, is_temporary_password: false, invite_status: 'accepted', passwordChangedAt: nowIso() }, { merge: true });
        } else throw error;
    }
    return { ok: true, orgId: u.orgId || null, email: u.email || null, wasTemporary: u.must_change_password === true };
}

/** People of the company with where each one is with signing in (no secrets) */
async function listAccess(orgId) {
    const [users, links] = await Promise.all([rawCollection('users').where('orgId', '==', orgId).get(), linksFor(orgId, 'setup')]);
    const open = new Map();
    links.filter((l) => L.linkState(l.data) === 'active').forEach((l) => { if (!open.has(l.data.uid)) open.set(l.data.uid, l.data.expiresAt); });
    return users.docs.map((d) => ({ ...d.data(), id: d.id })).filter((u) => u.email).map((u) => ({
        id: u.id, employeeId: u.employeeId || '', name: u.name || u.email || u.id, email: u.email, role: u.role || 'employee',
        access: L.accessStatus(u), linkExpiresAt: open.get(u.id) || null, createdAt: u.createdAt || null
    })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// ------------------------------------------------------------------------------------------- company join link

function publicLink(l) {
    const open = l.data.open === true;
    return { id: l.id, label: l.data.label || '', createdAt: l.data.createdAt, expiresAt: l.data.expiresAt, state: L.linkState(l.data), requests: Number(l.data.requests || 0),
        open, ...(open ? { maxPeople: Number(l.data.maxPeople || 0), joined: Number(l.data.joined || 0) } : {}) };
}

async function listJoinLinks(orgId) {
    return (await linksFor(orgId, 'join')).slice(0, 50).map(publicLink);
}

/**
 * A new company join link. The token is returned once; only its hash is stored.
 * open = { hours, maxPeople } makes an open link: the first maxPeople people who use it are let in without waiting.
 */
async function createJoinLink(orgId, actorId, days, label, open = null) {
    const exp = open ? L.openLinkFor(open.hours, open.maxPeople) : L.expiryFor('join', days);
    if (exp.error) return { ok: false, status: 400, error: exp.error };
    const active = (await linksFor(orgId, 'join')).filter((l) => L.linkState(l.data) === 'active');
    if (active.length >= L.MAX_ACTIVE_JOIN_LINKS) return { ok: false, status: 409, error: `You already have ${L.MAX_ACTIVE_JOIN_LINKS} working join links. Turn one off first.` };
    const { token, hash } = L.newToken();
    const data = { orgId, kind: 'join', label: String(label || '').replace(/[<>]/g, '').trim().slice(0, 60), createdAt: nowIso(), createdBy: actorId || null, expiresAt: exp.expiresAt, revokedAt: null, requests: 0,
        ...(open ? { open: true, maxPeople: exp.maxPeople, joined: 0 } : {}) };
    await rawCollection(LINKS).doc(hash).set(data);
    return { ok: true, token, link: publicLink({ id: hash, data }) };
}

async function revokeJoinLink(orgId, id, actorId) {
    if (!/^[0-9a-f]{64}$/.test(String(id))) return { ok: false, status: 404, error: 'Join link not found' };
    const ref = rawCollection(LINKS).doc(String(id));
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== orgId || snap.data().kind !== 'join') return { ok: false, status: 404, error: 'Join link not found' };
    if (snap.data().revokedAt) return { ok: false, status: 409, error: 'This link is already turned off' };
    await ref.set({ revokedAt: nowIso(), revokedBy: actorId || null }, { merge: true });
    return { ok: true };
}

async function joinInfo(token) {
    const link = await findActiveLink(token, 'join');
    if (!link) return null;
    const open = link.data.open === true && Number(link.data.joined || 0) < Number(link.data.maxPeople || 0);
    return { link, info: { company: await orgName(link.data.orgId), expiresAt: link.data.expiresAt, open } };
}

async function requestsOf(orgId) {
    const snap = await rawCollection(JOIN_REQUESTS).where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() }));
}

/**
 * Somebody asks to join with the company link. The answer is the same whether or not the email is already known, so the
 * page cannot be used to find out who has an account. A new login is made but switched off, and there is no person
 * record yet: nothing works for them until HR approves the request.
 */
async function submitJoinRequest(token, value, password, ip) {
    const found = await joinInfo(token);
    if (!found) return { ok: false, status: 404, error: 'This link does not work any more. Ask your employer for a new one.' };
    const orgId = found.link.data.orgId;
    const passwordHash = await bcrypt.hash(password, 10); // always done, so the time taken says nothing about the email
    const all = await requestsOf(orgId);
    if (all.filter((r) => r.data.status === 'waiting').length >= L.MAX_WAITING_REQUESTS) return { ok: false, status: 429, error: 'Too many people are waiting for approval right now. Ask your employer to look at the waiting list, then try again.' };
    if (await emailTaken(value.email)) return { ok: true, orgId, created: false };
    let uid;
    try {
        uid = (await admin.auth().createUser({ email: value.email, password, displayName: `${value.firstName} ${value.lastName}`, emailVerified: false, disabled: true })).uid;
    } catch (_) { return { ok: true, orgId, created: false }; }
    try {
        const ref = await rawCollection(JOIN_REQUESTS).add({ orgId, linkId: found.link.id, uid, firstName: value.firstName, lastName: value.lastName, email: value.email, phone: value.phone || '', passwordHash, status: 'waiting', createdAt: nowIso(), ip: ip || null });
        await found.link.ref.set({ requests: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
        const out = { ok: true, orgId, created: true, requestId: ref.id, open: found.link.data.open === true };
        if (out.open && await claimOpenPlace(found.link.ref, orgId)) {
            // No signed-in user here, so the approval runs as the link's own company (as completeSetup does)
            const r = await runWithTenant(orgId, async () => {
                const request = await getJoinRequest(orgId, ref.id);
                return request ? approveJoinRequest(orgId, request, `join-link:${found.link.id.slice(0, 12)}`) : { ok: false };
            }).catch(() => ({ ok: false }));
            if (r.ok) Object.assign(out, { approved: true, person: r.person });
            else await releaseOpenPlace(found.link.ref); // stays waiting for HR, and the place is given back
        }
        return out;
    } catch (error) {
        await admin.auth().deleteUser(uid).catch(() => {});
        throw error;
    }
}

/** Takes one place on an open link, if one is left (a transaction, so two people at once cannot both take the last one) */
async function claimOpenPlace(ref, orgId) {
    return runWithTenant(orgId, () => admin.firestore().runTransaction(async (tx) => {
        const s = await tx.get(ref); const d = (exists(s) && s.data()) || {};
        if (d.open !== true || L.linkState(d) !== 'active' || Number(d.joined || 0) >= Number(d.maxPeople || 0)) return false;
        tx.set(ref, { joined: Number(d.joined || 0) + 1, orgId }, { merge: true });
        return true;
    })).catch(() => false);
}
async function releaseOpenPlace(ref) {
    await ref.set({ joined: admin.firestore.FieldValue.increment(-1) }, { merge: true }).catch(() => {});
}

async function listJoinRequests(orgId) {
    return (await requestsOf(orgId)).map((r) => ({ id: r.id, firstName: r.data.firstName, lastName: r.data.lastName, email: r.data.email, phone: r.data.phone || '', status: r.data.status, createdAt: r.data.createdAt, decidedAt: r.data.decidedAt || null, employeeId: r.data.employeeId || null }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 300);
}

async function getJoinRequest(orgId, id) {
    if (!/^[A-Za-z0-9]{10,40}$/.test(String(id))) return null;
    const ref = rawCollection(JOIN_REQUESTS).doc(String(id));
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { id: snap.id, ref, data: snap.data() };
}

/** HR approves: the person record is made (always as a plain employee) and the login is switched on */
async function approveJoinRequest(orgId, request, actorId, { startDate, jobTitle, department } = {}) {
    if (request.data.status !== 'waiting') return { ok: false, status: 409, error: 'This request was already decided' };
    const validated = validatePerson({ firstName: request.data.firstName, lastName: request.data.lastName, email: request.data.email, phone: request.data.phone, role: 'employee', startDate: startDate || nowIso().slice(0, 10), jobTitle, department });
    if (validated.errors.length) return { ok: false, status: 400, errors: validated.errors };
    const taken = await rawCollection('users').where('email', '==', validated.value.email).limit(1).get();
    if (!taken.empty) return { ok: false, status: 409, error: 'That email already has an account. Reject this request.' };
    const [employeeId] = await allocateEmployeeIds(orgId, 1);
    const person = await createPerson(orgId, validated, employeeId, actorId, { existing: { uid: request.data.uid, passwordHash: request.data.passwordHash } });
    await request.ref.set({ status: 'approved', decidedAt: nowIso(), decidedBy: actorId || null, employeeId, passwordHash: null }, { merge: true });
    return { ok: true, person };
}

/** HR approves several requests at once. Each one is done on its own: one that fails does not stop the others. */
async function approveJoinRequests(orgId, ids, actorId, options = {}) {
    const approved = []; const failed = [];
    for (const id of ids) {
        const request = await getJoinRequest(orgId, id);
        if (!request) { failed.push({ id, error: 'Request not found' }); continue; }
        const r = await approveJoinRequest(orgId, request, actorId, options);
        if (r.ok) approved.push({ id, request, person: r.person });
        else failed.push({ id, error: r.error || (r.errors || []).join(' ') || 'Could not approve' });
    }
    return { approved, failed };
}

/** HR rejects: the switched-off login is removed (only if it never became a person) and the stored password hash is dropped */
async function rejectJoinRequest(orgId, request, actorId) {
    if (request.data.status !== 'waiting') return { ok: false, status: 409, error: 'This request was already decided' };
    const person = await rawCollection('users').doc(String(request.data.uid)).get();
    if (!exists(person)) await admin.auth().deleteUser(request.data.uid).catch(() => {});
    await request.ref.set({ status: 'rejected', decidedAt: nowIso(), decidedBy: actorId || null, passwordHash: null }, { merge: true });
    return { ok: true };
}

module.exports = {
    ALLOWED_ROLES, LINKS, JOIN_REQUESTS, temporaryPassword, allocateEmployeeIds, validatePerson, emailTaken, createPerson,
    createSetupLink, revokeSetupLinks, setupInfo, completeSetup, completeSetupWithPin, unknownPassword, reissueAccess, changeOwnPassword, listAccess,
    listJoinLinks, createJoinLink, revokeJoinLink, joinInfo, submitJoinRequest, listJoinRequests, getJoinRequest, approveJoinRequest, approveJoinRequests, rejectJoinRequest
};
