// Database rules for what a browser may do directly, run against the local Firestore emulator (it loads
// firestore.rules). The server itself uses the Admin SDK and is not bound by these rules; they are the only thing
// between a signed-in person with the public web key and the data.
// Skipped when the emulator is not running. What this does NOT cover: Storage rules, and the deployed rules of a
// live project (these are the rules in this repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const projectId = process.env.GCLOUD_PROJECT || 'kylrxai';
const base = `http://${host}/v1/projects/${projectId}/databases/(default)/documents`;
const emulatorUp = await fetch(`http://${host}/`).then(() => true).catch(() => false);
const skip = emulatorUp ? false : 'the Firestore emulator is not running';

const run = String(Date.now()).slice(-8);
const US = `org_rules_us_${run}`; const IN = `org_rules_in_${run}`; const OLD_US = `org_rules_oldus_${run}`; const OTHER = `org_rules_other_${run}`;
const token = ({ uid, role = 'employee', orgId, super_admin = false }) => jwt.sign({ sub: uid, user_id: uid, email: `${uid}@example.test`, role, ...(orgId ? { orgId } : {}), super_admin }, 'emulator_signing_secret');
const fieldsOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : v && typeof v === 'object' ? { mapValue: { fields: fieldsOf(v) } } : { stringValue: String(v) }]));
const asAdmin = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }; // the emulator's own bypass, standing in for the server
const seed = (path, data) => fetch(`${base}/${path}`, { method: 'PATCH', headers: asAdmin, body: JSON.stringify({ fields: fieldsOf(data) }) });
const made = [];
const put = async (path, data) => { made.push(path); const r = await seed(path, data); assert.equal(r.status, 200, `seeding ${path}`); };
const as = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const read = async (t, path) => (await fetch(`${base}/${path}`, { headers: as(t) })).status;
const write = async (t, path, data, mask) => (await fetch(`${base}/${path}${mask ? `?${mask.map((m) => `updateMask.fieldPaths=${m}`).join('&')}` : ''}`, { method: 'PATCH', headers: as(t), body: JSON.stringify({ fields: fieldsOf(data) }) })).status;
const create = async (t, col, id, data) => { made.push(`${col}/${id}`); return (await fetch(`${base}/${col}?documentId=${id}`, { method: 'POST', headers: as(t), body: JSON.stringify({ fields: fieldsOf(data) }) })).status; };
const del = async (t, path) => (await fetch(`${base}/${path}`, { method: 'DELETE', headers: as(t) })).status;

const usEmp = token({ uid: `us_emp_${run}`, orgId: US }); const usMate = `us_mate_${run}`; const usOwner = token({ uid: `us_owner_${run}`, orgId: US, role: 'super_admin', super_admin: true });
const oldUsEmp = token({ uid: `oldus_emp_${run}`, orgId: OLD_US });
const inEmp = token({ uid: `in_emp_${run}`, orgId: IN, role: 'Employee' }); const inMate = `in_mate_${run}`;

test.before(async () => {
    if (!emulatorUp) return;
    await put(`organizations/${US}`, { orgId: US, country: 'United States', countryCode: 'US', orgConfigured: true });
    await put(`organizations/${OLD_US}`, { orgId: OLD_US, Country: 'USA', orgConfigured: true }); // made before countryCode existed
    await put(`organizations/${IN}`, { orgId: IN, country: 'India', orgConfigured: true });
    await put(`users/us_emp_${run}`, { orgId: US, role: 'employee', name: 'Ann', status: 'active', must_change_password: true, password: 'hash-a', usProfile: { payRate: 18 } });
    await put(`users/${usMate}`, { orgId: US, role: 'employee', name: 'Bob', password: 'hash-b', usProfile: { payRate: 31 } });
    await put(`users/us_owner_${run}`, { orgId: US, role: 'super_admin', name: 'Olivia' });
    await put(`users/oldus_emp_${run}`, { orgId: OLD_US, role: 'employee', name: 'Cy' });
    await put(`users/in_emp_${run}`, { orgId: IN, role: 'Employee', name: 'Asha', status: 'active', must_change_password: true, password: 'hash-c' });
    await put(`users/${inMate}`, { orgId: IN, role: 'Employee', name: 'Ravi' });
    for (const org of [US, IN, OLD_US]) {
        await put(`timesheet_weeks/w_${org}`, { orgId: org, userId: 'x', status: 'submitted' });
        await put(`pay_results/p_${org}`, { orgId: org, userId: 'x', gross: 1000 });
        await put(`leave_requests/l_${org}`, { orgId: org, userId: 'x', status: 'pending' });
        await put(`api_keys/k_${org}`, { orgId: org, keyHash: 'abc' });
    }
});
test.after(async () => { if (emulatorUp) for (const p of new Set(made)) await fetch(`${base}/${p}`, { method: 'DELETE', headers: asAdmin }).catch(() => {}); });

test('US company: an employee cannot read or change pay, timesheets, time off or keys directly', { skip }, async () => {
    for (const path of [`pay_results/p_${US}`, `timesheet_weeks/w_${US}`, `leave_requests/l_${US}`, `api_keys/k_${US}`]) assert.equal(await read(usEmp, path), 403, `read ${path}`);
    assert.equal(await write(usEmp, `timesheet_weeks/w_${US}`, { status: 'approved' }, ['status']), 403, 'approving their own week');
    assert.equal(await write(usEmp, `leave_requests/l_${US}`, { status: 'approved' }, ['status']), 403, 'approving their own time off');
    assert.equal(await create(usEmp, 'time_punches', `tp_${run}`, { orgId: US, userId: `us_emp_${run}`, type: 'in' }), 403, 'adding a punch');
    assert.equal(await del(usEmp, `pay_results/p_${US}`), 403);
    // the owner is no exception: the owner's page goes through the server too
    assert.equal(await read(usOwner, `pay_results/p_${US}`), 403);
    assert.equal(await write(usOwner, `organizations/${US}`, { country: 'India' }, ['country']), 403, 'switching the protection off by changing the country');
});

test('US company: a person reads their own record and their company, and nobody else\'s record', { skip }, async () => {
    assert.equal(await read(usEmp, `users/us_emp_${run}`), 200);
    assert.equal(await read(usEmp, `organizations/${US}`), 200);
    assert.equal(await read(usEmp, `users/${usMate}`), 403, 'a coworker\'s record holds pay and a password hash');
    assert.equal(await read(usEmp, `organizations/${IN}`), 403);
    for (const [field, value] of [['must_change_password', false], ['status', 'terminated'], ['name', 'Ann B'], ['password', 'mine']]) assert.equal(await write(usEmp, `users/us_emp_${run}`, { [field]: value }, [field]), 403, `changing own ${field}`);
    assert.equal(await write(usEmp, `users/us_emp_${run}`, { usProfile: { payRate: 99 } }, ['usProfile']), 403, 'giving themselves a raise');
});

test('a US company made before the country code existed is protected the same way', { skip }, async () => {
    assert.equal(await read(oldUsEmp, `pay_results/p_${OLD_US}`), 403);
    assert.equal(await read(oldUsEmp, `leave_requests/l_${OLD_US}`), 403);
    assert.equal(await read(oldUsEmp, `users/oldus_emp_${run}`), 200);
});

test('every company: collections only the server uses are closed to browsers', { skip }, async () => {
    for (const path of [`pay_results/p_${IN}`, `timesheet_weeks/w_${IN}`, `api_keys/k_${IN}`]) assert.equal(await read(inEmp, path), 403, `read ${path}`);
    assert.equal(await create(inEmp, 'otp_verifications', `otp_${run}`, { orgId: IN, code: '000000' }), 403);
    assert.equal(await create(inEmp, 'gusto_connections', `g_${run}`, { orgId: IN }), 403);
});

test('India company: the pages that read the database directly keep working', { skip }, async () => {
    assert.equal(await read(inEmp, `leave_requests/l_${IN}`), 200);
    assert.equal(await read(inEmp, `users/${inMate}`), 200, 'coworker lists are read by the pages');
    assert.equal(await write(inEmp, `users/in_emp_${run}`, { name: 'Asha K' }, ['name']), 200, 'own plain fields');
    assert.equal(await write(inEmp, `users/in_emp_${run}`, { status: 'Completed' }, ['status']), 200, 'the onboarding page sets this');
    assert.equal(await create(inEmp, 'leave_requests', `lr_${run}`, { orgId: IN, userId: `in_emp_${run}`, status: 'pending' }), 200);
    assert.equal(await read(inEmp, `leave_requests/l_${US}`), 403, 'never another company');
});

test('every company: a person cannot clear their forced password change, set a password hash or PIN, or edit US pay fields', { skip }, async () => {
    for (const [field, value] of [['must_change_password', false], ['password', 'mine'], ['pinHash', 'x'], ['pinLockedUntil', ''], ['superAdmin', true]]) assert.equal(await write(inEmp, `users/in_emp_${run}`, { [field]: value }, [field]), 403, `changing own ${field}`);
    assert.equal(await write(inEmp, `users/in_emp_${run}`, { usProfile: { payRate: 99 } }, ['usProfile']), 403);
});

test('a new sign-in cannot write itself into a company it does not belong to', { skip }, async () => {
    const stranger = token({ uid: `stranger_${run}` }); // signed in, no company on the sign-in
    assert.equal(await create(stranger, 'users', `stranger_${run}`, { name: 'Mallory', role: 'Employee', orgId: IN }), 403, 'naming someone else\'s company');
    assert.equal(await create(stranger, 'users', `stranger_${run}`, { name: 'Mallory', role: 'Employee', password: 'x' }), 403, 'carrying a sign-in field');
    assert.equal(await create(stranger, 'users', `stranger_${run}`, { name: 'Mallory', role: 'Employee' }), 200, 'a plain record with no company is still allowed');
    const member = token({ uid: `member_${run}`, orgId: IN, role: 'Employee' });
    assert.equal(await create(member, 'users', `member_${run}`, { name: 'New hire', role: 'Employee', orgId: OTHER }), 403);
    assert.equal(await create(member, 'users', `member_${run}`, { name: 'New hire', role: 'Employee', orgId: IN }), 200, 'the company the sign-in already carries');
    const usNew = token({ uid: `usnew_${run}`, orgId: US });
    assert.equal(await create(usNew, 'users', `usnew_${run}`, { name: 'New hire', role: 'employee', orgId: US }), 403, 'in an API-only company the server makes the record');
});
