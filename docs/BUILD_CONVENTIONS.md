# How we build here (read this first)

Repo: `C:\kylrxaisuite` (Node/Express 5 + Firebase Admin; plain HTML/JS pages). Branch `feature/usa-foundation`. Windows, PowerShell + Git Bash. Files use CRLF; Edit/Write tools are fine.

## Ground rules for parallel builders
- **Create new files**; avoid editing existing ones. The only existing files you may touch: add ONE `app.use("/api/us", require("./routes/<yours>"))` line (or `/api/v1` etc.) to `server.js` right after the `./routes/us-vault` / `./routes/us-compliance` mounts; append your test file names to the `npm test` list in `package.json` (same line, space-separated); add nav links to `admin-dashboard.html` only if told to. Use small Edit calls and retry if the file changed under you. Never rewrite whole shared files.
- **Do not commit, do not touch `docs/USA_PROGRESS.md`, do not use the browser pane** (it is shared). Test with PowerShell/curl/node.
- **Run your own server on your own port**: `$env:PORT='31xx'; node scripts/start-local.js` (the port you were given). Stop only your own process (find it by your port). Never stop other node processes. The Firebase emulators (Auth 9099, Firestore 8080) are already running; do not restart them.
- Final report to the lead: **max 250 words**: files created, lines added to shared files, nav links wanted, number of tests, what could not be tested and why, any decision you made.

## Do not hard-code law
State and city rules change. Keep them **data-driven** (a rules table the company can edit, with effective dates where it matters) and show a note: "confirm with a US compliance advisor". Never state a rule as fact in the UI unless it is a well-known federal rule.

## Layers
- `services/<x>-rules.js` pure functions (no I/O) + `tests/<x>.test.mjs` (`node:test`, `createRequire`, see `tests/leave-rules.test.mjs`). Pure first, then I/O.
- `routes/<x>.js` Express router. Pattern (see `routes/us-leave.js`, `routes/us-vault.js`):
  ```js
  const { requireUsOrg, findEmployee, audit, exists, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;   // US-company guard, person lookup, audit log
  const { orgInfo, punchesSince } = require('./time').helpers;                                           // org time zone, rules
  const { requirePermission, can, canManage } = require('../services/permissions');
  router.use(verifyToken);
  router.get('/x', requirePermission('reports.view'), requireUsOrg, async (req, res) => { ... });
  ```
  `req.orgId` is set by `requireUsOrg`. People live in Firestore `users` (doc id = login uid, has `orgId`, `employeeId`, `name`, `role`, `status`, `usProfile{...}`, `usForms{...}`) and sometimes `employees`. Use `rawCollection('<name>')` from `../config/firebase` and **always filter/check `orgId` yourself**. New collections: top-level, every doc has `orgId`.
  Responses: `{ success: true, ... }` / `{ success: false, error }` / `{ success: false, errors: [...] }` (400 for validation, 403, 404, 409 for state conflicts). Express 5 forwards async errors.
- **Permissions**: `services/permissions.js` (`can`, `requirePermission`, `requireAnyPermission`, `canManage(user, personData, 'time'|'leave')`). Roles: super_admin, hr_admin, payroll_admin, manager (own direct reports only: `usProfile.managerId`), employee, accountant (read-only), auditor (read-only), executive (reports). Add new permission keys to `PERMISSIONS` only when truly new (append; keep existing).
- **Audit**: `audit(orgId, req, 'action_name', targetId, { extra })` for every sensitive read/write. Never put secrets/SSNs in audit.
- **PII / secrets**: `services/pii-crypto.js` `encryptField/decryptField(value, 'orgId:recordId')`, `encryptBuffer/decryptBuffer`; files via `services/file-store.js`. Store provider tokens and API secrets encrypted; never log them; show only last 4 / masked.
- Time zone: `await orgInfo(orgId)` -> `{ tz, country, rules }`; `services/time-rules.js` `localDate`, `weekStart`, `zonedToUtcIso`.
- Existing pure modules worth reusing: `us-forms.js` (business days, holidays, parseIsoDate), `us-validation.js`, `leave-rules.js`, `time-policy.js`, `checklist-rules.js`, `us-reports.js`, `vault-rules.js`.

## Pages
Standalone HTML in the repo root, style like `admin-us-leave.html` (HR) and `leave.html` (employee: phone-first, big controls, **English + Spanish** with the `kylrx_lang` localStorage key). `import { auth, onAuthStateChanged } from './firebase-config.js'`, call APIs with `Authorization: Bearer ${await auth.currentUser.getIdToken()}`. No inline event-handler attributes (CSP blocks them); use addEventListener. Run `node --check` on the extracted module script. Employee pages must work at 375px width.

## Test data and logins (local only)
Demo accounts (password `LocalTest#2026`): `superadmin@us.demo.local`, `hr@us.demo.local`, `manager@us.demo.local`, `employee@us.demo.local` (company `org_demo_us`, country US, TX). India company: `superadmin@demo.local`.
Login: `POST /api/auth/login {email,password}` returns `mfaToken` and (dev) `code`; then `POST /api/auth/verify-mfa {mfaToken, code}` returns `accessToken`. Create a test worker: `POST /api/us/employees {firstName,lastName,email,role,startDate,jobTitle}` (HR token) returns `employee.uid` and a one-time `temporaryPassword`. Use unique emails (suffix with a random number) so parallel builders do not collide. Set a person's manager by writing `usProfile.managerId` on their `users` doc (admin SDK) until the people-data module ships an endpoint.
Quick PowerShell helpers are in `docs/LOCAL_TESTING.md`; `npm test` runs everything and should end with 0 failures (it runs two groups: `test:main`, then `test:servers` for the two files that start their own HTTP server and crash on Windows when force-exited). Add new test files to `test:main`.

## Done means
Pure rules tested; routes tested live with real tokens for: allowed role, forbidden role (employee, India admin `superadmin@demo.local` -> 409), cross-company isolation, validation errors; a page per audience; `node --check` clean; audit entries written; no secrets in responses; notes about what needs real external credentials.
