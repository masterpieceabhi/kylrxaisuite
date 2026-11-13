# India readiness: what works, what is missing

Tested 2026-11-11 on a local copy (Firebase emulators), logged in as a Super Admin, using `Templates.xlsx` plus 9 sample employees created through the API. Not tested against the live Firebase project.

## Works (checked)
- Login with password + email one-time code; role checks (Employee gets 403 on admin routes).
- 106 of 108 readable API endpoints return 200 with an admin token. Failing: `GET /api/admin/attendance-policies` (500), `GET /api/data/fetch` (400, needs a parameter).
- All 84 pages are served.
- Setup wizard, after the fixes below: organization profile + `orgConfigured`, business units (4), cost centers (7), sub-departments (6), attendance policies (4), employee types (6), payroll components (13), roles (7), statutory rules (6), workflows (6), gratuity details (4), salary structures (3), employee finance (3), holiday calendar (20 holidays).
- Employee creation through `POST /api/admin/employees`; payslip generation (201); payout batch creation with maker-checker (201).
- ESIC constants match current law (wage limit 21,000; 0.75% / 3.25%). Payroll engine prorates for unpaid leave correctly.

## Fixed in this branch
1. Login bypass (`?role=super_admin`, dev tokens) - earlier commit.
2. Setup wizard final step wrote the employee-ID counter from the browser; rules allow server-only writes, so the step failed with PERMISSION_DENIED. Now non-fatal (the server creates the counter at signup).
3. Silent data loss: services called `window.db.collection(...).doc(...).set(...)` (old API) on a modular Firestore object. It threw, was swallowed, the UI said "ingested successfully", and data stayed only in browser memory. Added a compatibility layer in `firebase-config.js`.
4. `window.firebaseFirestore` was never defined, but 11 services (63 references: holiday calendar, cost center, shifts, finance, ...) read it, so their saves never reached the cloud. Now defined.
5. Rules had no entry for `holiday_calendars/{code}/holidays/{id}` (two levels deep); added.

## Not working / missing
| Area | Status |
|---|---|
| Shifts & week-offs, PF (EPFO), ESIC, PT, LWF, NPS master uploads | Their ingest buttons never appear after loading `Templates.xlsx` (hidden), so these were **not loaded or tested**. Needs a per-tab investigation (sheet-name matching). |
| Employee roster upload (Job & Rosters tab) | Uses a separate importer that expects a different template and defaults to a hard-coded company ID (`ORG_KYLRX_CORP`); it wrote no employees. Employees were created through the API instead. |
| Employee IDs | The wizard promises sequential `EMP0001`, but the API creates random IDs such as `ENG-A0E161`. |
| PF on unpaid leave | Engine charged 12% of the full basic (3,600) instead of earned basic (3,240) in one test. Needs checking in the real payroll path. |
| Payroll engine | Totals wage bases for PF/ESIC/PT/TDS but takes deductions as input; TDS (income tax) is not computed there. |
| Salary/finance data in UI | Seeded, but screens were not walked through with data yet. |
| Bank payout | Decentro is staging only; no live keys, not tested end to end. |
| Register export | Excel register call failed with my test payload; not confirmed either way. |
| PF/ESIC/Gratuity/NPS APIs | Base paths return 404 (no index route); specific endpoints not exercised. |
| Security | Demo passwords hard-coded in `login.js` / `statutory-compliance.html`; 32 known dependency vulnerabilities; `smtpjs.com` script in Payroll Document Center; `TENANT_READ_SCOPING` off. |
| Tests | 132 of 134 pass; the 2 failures are a Windows exit crash. |

## Suggested order to finish India
1. Shifts + PF/ESIC/PT/LWF/NPS masters (load, then confirm each statutory screen shows real figures).
2. One full month: attendance -> payroll run -> payslips -> PF/ESIC challans -> bank file -> reconciliation.
3. PF-on-LOP and TDS checks with an Indian payroll consultant.
4. Fix the roster importer and employee ID scheme.
5. Security items above, then outside review.
