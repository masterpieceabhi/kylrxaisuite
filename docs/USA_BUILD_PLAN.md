# USA HR software: build plan

Status: draft for team review. Companion to `USA_RULES_DRAFT.md` (rules) and `INDIA_READINESS.md` (what exists today).
Sizing is a planning estimate, not a commitment. Gusto facts come from Gusto's public Embedded Payroll developer docs (read 2026-11-11); items marked **(confirm)** were not stated in those docs and must be confirmed with Gusto.

## 1. Product shape

Three layers:

1. **HR system of record (we build):** people, hiring paperwork, time, leave, documents, performance, reports. Runs on the existing Kylrx base once country-aware.
2. **Payroll engine (Gusto Embedded, we integrate):** tax calculation, payroll runs, tax filing and payment, W-2/1099, benefits admin. We do not build a US tax engine.
3. **Connector layer (we build):** a public API, webhooks and prebuilt connectors so ERPs and other apps can read and write HR data.

Rule: the HR system is the source of truth for people and time; Gusto is the source of truth for pay and tax results. Data syncs both ways through one integration service (section 4).

## 2. Function catalog (what we are building)

IDs are stable so the team can track them. "Exists" = usable from the current codebase with country changes; everything else is new.

### A. Platform and country foundation
- US-A01 Country switch per company (IN / US / CA) driving currency, date, time zone, ID fields, visible modules. *(new, builds on org setup)*
- US-A02 US company profile: legal name, EIN, entity type, addresses by state, industry code, fiscal year.
- US-A03 Multi-state / multi-location work-site model (state, county, city tax jurisdictions).
- US-A04 Hide India-only modules (PF, ESIC, PT, LWF, NPS, Gratuity) for US companies.
- US-A05 USD currency and US number/date/address formatting; US time zones and DST.
- US-A06 Effective-dated rules tables (min wage, overtime, sick leave), reviewed each January.
- US-A07 Role model for US: Owner, HR Admin, Payroll Admin, Manager, Employee, Accountant (read-only), Auditor.
- US-A08 SSN/ITIN encryption at rest, masking (last 4), reveal with audit log.
- US-A09 Data residency in a US region; backup and restore.
- US-A10 Audit trail on every change to people, pay and tax data.

### B. People and organization
- US-B01 Employee record (legal and preferred name, address, DOB, work state, emergency contacts).
- US-B02 Worker classification: W-2 employee vs 1099 contractor; exempt vs non-exempt; full/part time.
- US-B03 Org chart, departments, managers, reporting lines. *(exists)*
- US-B04 Job, title, compensation history with effective dates.
- US-B05 Pay setup: hourly or salary, frequency, direct deposit split, pay schedule assignment.
- US-B06 Custom fields and employee tags.
- US-B07 Bulk import (CSV/Excel) with validation and preview.
- US-B08 Employee self-service profile edits with approval.
- US-B09 Termination and rehire flows with last-day logic.
- US-B10 Contractor records and 1099 data (TIN, W-9 status).

### C. Hiring and onboarding
- US-C01 Candidate and requisition tracking, pipeline stages.
- US-C02 Offer letter templates and e-signature.
- US-C03 Onboarding checklist builder with due dates and reminders. *(exists, adapt)*
- US-C04 Form W-4 collection and storage (federal and state withholding forms).
- US-C05 Form I-9: Section 1 by day one, Section 2 within 3 business days, document upload, expiry tracking, reverification alerts.
- US-C06 E-Verify hand-off tracking (record of case results).
- US-C07 State new-hire reporting by deadline per state.
- US-C08 Direct-deposit form and bank validation.
- US-C09 Handbook and policy acknowledgements. *(exists)*
- US-C10 Background-check provider hook.

### D. Time, attendance and scheduling
- US-D01 Clock in/out (web, mobile) with optional geofence and IP rules. *(exists)*
- US-D02 Timesheets with weekly approval by manager.
- US-D03 Overtime engine: over 40 hours per workweek at 1.5x; state daily/double-time rules (e.g. California).
- US-D04 Meal and rest break rules and missed-break premiums by state.
- US-D05 Minimum-wage checks (federal, state, city) with alerts.
- US-D06 Shift scheduling, swaps, open shifts, publish to team. *(partly exists)*
- US-D07 Predictive-scheduling rule checks (notice windows) where required.
- US-D08 Tip and tipped-minimum-wage tracking.
- US-D09 Hours-to-payroll export per pay period (feeds Gusto).
- US-D10 Attendance exceptions: late, missed punch, regularization. *(exists)*
- US-D11 Job/project/cost-center time allocation for ERP costing.

### E. Leave and holidays
- US-E01 PTO/vacation policies and accrual engine.
- US-E02 Paid sick leave by state/city: accrual, carryover, caps, usage rules.
- US-E03 FMLA eligibility tracking and leave case management.
- US-E04 Other statutory leave (jury duty, military, bereavement, parental) by state.
- US-E05 Leave requests, approvals, calendar and team view. *(exists)*
- US-E06 US federal holiday calendar plus company holidays. *(exists)*
- US-E07 Balance statements and payout-at-termination rules by state.
- US-E08 Two-way sync of time-off policies and requests with Gusto.

### F. Payroll (through Gusto)
- US-F01 Company payroll onboarding wizard (see section 3).
- US-F02 Pay schedule management.
- US-F03 Employee payroll profile sync (W-4, state taxes, bank, compensation).
- US-F04 Payroll preview: hours and pay into Gusto, calculated results back, blocker list.
- US-F05 Regular payroll run submit and cancel.
- US-F06 Off-cycle payrolls (bonus, correction, termination pay).
- US-F07 Contractor payments and payment groups.
- US-F08 Pay stubs and payroll register in our UI.
- US-F09 Tax filing and payment status dashboard (read from Gusto).
- US-F10 Year-end: W-2 and 1099 availability, corrections status.
- US-F11 Garnishment and deduction tracking (non-child-support garnishments need partner handling **(confirm)**).
- US-F12 Payroll journal / general ledger export (via Gusto report and our connector).
- US-F13 Historical payroll import for mid-year switchers.

### G. Benefits
- US-G01 Benefit plan catalog (health, dental, vision, 401(k), HSA/FSA).
- US-G02 Enrollment and open-enrollment windows.
- US-G03 Employee and employer contributions flowing to payroll.
- US-G04 Life-event changes.
- US-G05 401(k) provider hook (Gusto partner options) and ACA tracking data.
- US-G06 Benefit summaries for employees.

### H. Documents and compliance
- US-H01 Document vault by employee and company with retention rules.
- US-H02 E-signature for company and employee documents.
- US-H03 Compliance calendar (I-9 audits, new-hire reports, posters, filing dates).
- US-H04 Labor law poster and handbook state add-ons.
- US-H05 EEO-1 and demographic reporting data.
- US-H06 OSHA incident log (300/300A) basics.
- US-H07 I-9 audit report and missing-document report.
- US-H08 Policy library with versions. *(exists)*

### I. Performance and engagement
- US-I01 Goals and reviews. *(exists)*
- US-I02 Review cycles, 360 feedback.
- US-I03 Pulse surveys and eNPS. *(partly exists)*
- US-I04 Recognition and announcements.
- US-I05 Asset tracking. *(exists)*
- US-I06 Exit interviews and offboarding checklist. *(exists)*

### J. Analytics and reporting
- US-J01 Headcount, turnover, tenure dashboards.
- US-J02 Labor cost and overtime reports.
- US-J03 Time-off liability report.
- US-J04 Compliance status report (I-9, W-4, training).
- US-J05 Custom report builder and scheduled exports. *(exists, adapt)*
- US-J06 Payroll cost by department/project from Gusto data.

### K. Integration platform (connectors)
- US-K01 Public REST API (versioned) for people, jobs, time, leave, documents, payroll results.
- US-K02 API keys and OAuth 2.0 apps with scopes per company.
- US-K03 Outbound webhooks with signing, retries, replay.
- US-K04 Event bus for internal and external events. *(partly exists: `services/event-bus.js`)*
- US-K05 Connector SDK: field mapping, transforms, per-company config UI.
- US-K06 Sync engine with change tracking, conflict rules, dead-letter queue, reconciliation reports.
- US-K07 Bulk import/export: CSV, SFTP drops, scheduled files.
- US-K08 Prebuilt connectors, phase 1: QuickBooks Online, Xero, NetSuite.
- US-K09 Prebuilt connectors, phase 2: SAP, Microsoft Dynamics, Oracle, Workday Financials, Sage Intacct.
- US-K10 Prebuilt connectors, phase 2: Slack, Microsoft Teams, Google Workspace, Okta/Entra ID (provisioning/SCIM).
- US-K11 Automation platform listing (Zapier / Make) built on the public API.
- US-K12 Integration health dashboard, logs, alerts, per-tenant rate limits.
- US-K13 Developer portal: docs, sandbox company, API explorer.
- US-K14 Partner approval flow (customer admin authorizes an app and scopes).

### L. Security, privacy and operations
- US-L01 MFA enforced for admins; SSO (SAML/OIDC) for customers.
- US-L02 Fix the known issues first (login bypass done; demo passwords, dependency vulnerabilities, tenant scoping on).
- US-L03 Field-level encryption for SSN and bank data; key management.
- US-L04 State privacy features: data export and deletion requests (CCPA/CPRA).
- US-L05 Centralized logging, monitoring, alerting, backups, disaster recovery.
- US-L06 Security audit, penetration test, then SOC 2 Type I, then Type II (buyers and Gusto will ask).
- US-L07 Billing and subscription (per employee per month), invoices, tax on SaaS where applicable.
- US-L08 Customer support tooling: impersonation with consent and audit, status page.
- US-L09 Production deployment pipeline, environments, release process.

(Total is computed in section 8.)

## 3. Gusto Embedded Payroll integration

### What Gusto covers (from its docs)
Companies, W-2 employees, contractors, regular and off-cycle payrolls, pay schedules, tax requirements and payments (read), benefits, time-off policies and requests, forms and documents (company forms, I-9 guide, W-4 via federal tax endpoints), reports (custom, general ledger), webhooks and an events API. Pre-built UI "Flows" and a React SDK exist, or we can use the pure API, or a hybrid.

### Access and approval (long lead item: start now)
- Gusto says it cannot support every partner use case; commercial, security and implementation reviews come before production. Contact: embedded-info.gusto.com/contact-us. **Pricing, approval timeline and any certification requirement (e.g. SOC 2) were not stated in the docs: confirm.**
- Developer Portal account gives a **demo** environment (`api.gusto-demo.com`) with instant company approval for testing. Production scopes are assigned by Gusto per use case.
- Each customer company also goes through Gusto onboarding and a risk review (up to 2 business days, often faster) before it can run payroll.
- Who carries liability for tax filing errors was not stated in the docs: confirm in the contract.

### Technical design
- **Auth:** system token (2 hours) to create companies; one company token per customer (2-hour access, rotating refresh token). Refresh must be serialized per company (row lock) because each refresh revokes the previous one. Tokens stored encrypted; never in the browser.
- **Versioning:** send `X-Gusto-API-Version`; pin a version; budget for roughly quarterly breaking-change releases and 12-month support windows; tolerate unknown enum values.
- **Limits:** 200 requests/minute per application and user; queue and back off on 429 using the rate-limit headers. Use batch endpoints (people batches) for bulk employee creation.
- **Writes:** POST with an idempotency key **(confirm header name)**; PUT sends the object's `version` and handles 409 conflicts by re-reading.
- **Webhooks:** one subscription per entity type (Company, Employee, Payroll, Form, Document, TimeOffRequest, Notifications, etc.); verify signature (HMAC-SHA256 with the verification token in `X-Gusto-Signature`); answer 2xx within 10 seconds, process asynchronously; Gusto retries up to 16 times over 3 days, so handlers must be idempotent. Backstop with the Events API for missed events.
- **Company onboarding flow (US-F01):** create partner-managed company and accept terms; locations, bank account (micro-deposits 1 to 2 business days, or Plaid), federal tax details, industry, pay schedule; employees (batch) and at least one onboarded; state tax requirements; signatory and signed forms (e.g. Form 8655); finish onboarding; wait for the `company.approved` event. Our UI either embeds Gusto Flows (fastest) or reimplements steps with the API (more control, more work). Recommendation: Flows first, replace screens over time.

### Data ownership and mapping
| Data | Source of truth | Direction |
|---|---|---|
| Person, job, org, manager | Our HR | to Gusto |
| W-4, state tax, bank, compensation | Gusto (entered via Gusto flows or our forms) | both, Gusto wins on conflict |
| Hours worked, PTO used | Our HR (time module) | to Gusto each pay period |
| Pay calculations, taxes, stubs, filings | Gusto | to our HR (read-only) |
| Time-off policy and requests | Our HR | to Gusto |

### What we must build ourselves
- **Time tracking and hours import:** Gusto's docs describe hourly hours per pay period but do not show how a partner imports them **(confirm: endpoint and format)**. Our time module (US-D) is the source and must feed payroll preview (US-F04).
- Mapping of our employees to Gusto employee UUIDs, sync state, retries and a reconciliation report.
- Non-child-support garnishment payment handling **(confirm)**.
- Cutoffs: payroll deadline is 4 PM Pacific on business days; standard ACH takes about 4 business days; the UI must warn accordingly.

### Alternative to evaluate in parallel
Gusto also has an "App Integrations" API for connecting to existing Gusto.com customers (different product, different auth). Useful later for customers who already run Gusto; not the same as Embedded.

## 4. Connector framework (US-K)

Design goal: any ERP or app that needs HR data connects through the same layer, so each new connector is configuration plus a small adapter, not a new system.

1. **Canonical HR model:** one versioned schema (Person, Job, Org unit, Time entry, Leave, Pay result, Document). Everything inside the product and every connector speaks it.
2. **Ingress/egress paths:** public REST API (pull), outbound webhooks (push), file drops (CSV/SFTP) for legacy ERPs, and a managed-connector runtime.
3. **Connector runtime:** adapter interface (`authenticate`, `pull`, `push`, `map`, `validate`), per-company field mapping UI, schedules, change tracking by `updatedAt` and event ids, conflict policy (source-of-truth per field), dead-letter queue, replay.
4. **Gusto is the first connector built on this runtime**, which proves the framework before ERPs.
5. **Security:** scoped OAuth apps and API keys per company, per-connector least privilege, encrypted secrets, full audit of reads, tenant rate limits, no PII in logs.
6. **Build vs buy:** unified-API vendors (e.g. Merge, Finch-style) can supply many ERP and HRIS connectors faster; compare cost, data-residency and margin against building. Decision needed before phase 3.
7. **Typical ERP flows:** payroll journal entries to the general ledger, employee/vendor master sync, cost-center and project time for costing, headcount for budgeting.

## 5. Phases (estimates, planning only)

| Phase | Scope | Rough duration* |
|---|---|---|
| 0. Preconditions | Fix security issues (L02), country switch (A01), Gusto partner outreach, pick build-vs-buy for connectors | 3 to 5 weeks (Gusto approval runs in parallel, unknown length) |
| 1. US HR core | A, B, C (W-4, I-9), E, H basics | 8 to 12 weeks |
| 2. Time and overtime | D, E02 sick leave, state rule tables | 6 to 8 weeks |
| 3. Gusto integration | F, G basics, webhooks, onboarding flow, reconciliation | 8 to 12 weeks (needs approval + demo access earlier) |
| 4. Integration platform | K01 to K07, K12, K13, Gusto as first connector | 8 to 10 weeks, overlaps phase 3 |
| 5. ERP connectors | K08 then K09/K10/K11 | 4 to 6 weeks each for the first few |
| 6. Pilot | 2 to 3 friendly US companies, real payroll through Gusto | 6 to 8 weeks |
| 7. Hardening and trust | L06 audit, pen test, SOC 2 Type I then II | audit starts at phase 3; Type II needs months of evidence |
| 8. Canada | Same architecture, Canadian payroll partner | after US pilot |

*Assumes a small dedicated team (about 4 to 6 engineers plus a US payroll/HR compliance advisor). Phases overlap; calendar total is roughly 8 to 12 months to first paying US customers, depending mostly on Gusto approval and team size.

## 6. Risks and open questions
- Gusto partner approval, pricing and liability terms are unknown; they can change margins and timelines. Ask first.
- Time-import path into Gusto is unconfirmed; may force a different design for hourly workers.
- Gusto does not cover everything (e.g. some garnishments, some state tax changes after onboarding need Gusto support).
- SOC 2 expectations from US buyers and possibly Gusto.
- The existing codebase has structural issues found in the India review (silent save failures, hard-coded demo credentials). Fixing them first is cheaper than carrying them into the US product.
- Team capacity and who owns US payroll/HR compliance knowledge.

## 7. Decisions needed from you
1. Approve starting Gusto partner outreach now.
2. Build vs buy for connectors (section 4, item 6).
3. Embed Gusto Flows first, or full custom UI.
4. Team size and who is the US compliance advisor.
5. Target launch date and pilot customers.

## 8. Totals
111 functions in 12 modules (counted from section 2):

| Module | Functions |
|---|---|
| A Platform and country foundation | 10 |
| B People and organization | 10 |
| C Hiring and onboarding | 10 |
| D Time, attendance, scheduling | 11 |
| E Leave and holidays | 8 |
| F Payroll (via Gusto) | 13 |
| G Benefits | 6 |
| H Documents and compliance | 8 |
| I Performance and engagement | 6 |
| J Analytics and reporting | 6 |
| K Integration platform (connectors) | 14 |
| L Security, privacy, operations | 9 |

Of the 111, 12 are marked as existing in the current code (usable after country changes) and 3 more partly exist; about 96 are new work.
