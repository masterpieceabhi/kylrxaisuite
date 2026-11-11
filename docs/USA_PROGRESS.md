# USA build progress

As of 2026-11-11 on branch `feature/usa-foundation`. Measured against the 111 functions in `USA_BUILD_PLAN.md`.

Status meanings: **Done** = built and tested; **Partial** = core works, pieces missing; **Existing, not adapted** = code exists from the India app but is not set up or tested for US; **Not started**; **Later** = deliberately postponed (Gusto payroll and connectors).

## Totals

| Status | Count |
|---|---|
| Done | 12 |
| Partial | 23 |
| Existing, not adapted | 8 |
| Not started | 38 |
| Later (Gusto/connectors) | 30 |
| **All** | **111** |

Not counting the postponed Gusto and connector work, there are 81 functions: 12 done, 23 partial, 8 existing-not-adapted, 38 not started.

## By module

| Module | Done | Partial | Existing | Not started | Later |
|---|---|---|---|---|---|
| A Platform and country | 1 | 7 | 0 | 2 | 0 |
| B People and organization | 3 | 3 | 1 | 3 | 0 |
| C Hiring and onboarding | 3 | 1 | 2 | 4 | 0 |
| D Time, attendance, scheduling | 1 | 4 | 0 | 5 | 1 |
| E Leave and holidays | 3 | 2 | 0 | 2 | 1 |
| F Payroll (Gusto) | 0 | 0 | 0 | 0 | 13 |
| G Benefits | 0 | 0 | 0 | 6 | 0 |
| H Documents and compliance | 0 | 3 | 1 | 4 | 0 |
| I Performance and engagement | 0 | 1 | 3 | 2 | 0 |
| J Analytics and reporting | 0 | 0 | 1 | 4 | 1 |
| K Connectors | 0 | 0 | 0 | 0 | 14 |
| L Security, privacy, operations | 1 | 2 | 0 | 6 | 0 |

## Done (12)

- US-A08 SSN/ITIN encryption at rest, masking (last 4), reveal with audit log. - SSN/ITIN and I-9 document numbers encrypted, masked, reveal needs a reason and is logged
- US-B02 Worker classification: W-2 employee vs 1099 contractor; exempt vs non-exempt; full/part time. - W-2 vs 1099, exempt vs non-exempt, full/part time with rule checks
- US-B07 Bulk import (CSV/Excel) with validation and preview. - CSV/Excel upload with a check-first step, row-by-row errors and a template
- US-B09 Termination and rehire flows with last-day logic. - Termination with last day, scheduled access shut-off, leave cancelled, final summary, cancel before last day, rehire with I-9 guidance
- US-C04 Form W-4 collection and storage (federal and state withholding forms). - Federal W-4 with signature, history, plain language EN/ES (state forms not included)
- US-C05 Form I-9: Section 1 by day one, Section 2 within 3 business days, document upload, expiry tracking, reverification alerts. - I-9 Sections 1 and 2, 3-business-day deadline, expiry and retention dates, HR status table
- US-C08 Direct-deposit form and bank validation. - Direct deposit with routing-number check, encrypted account number, shown as last 4 only
- US-D01 Clock in/out (web, mobile) with optional geofence and IP rules. - Any role, big-button phone page, shared-tablet PIN kiosk, EN/ES, floating clock button
- US-E01 PTO/vacation policies and accrual engine. - PTO policies with accrual, caps, carryover, waiting period
- US-E02 Paid sick leave by state/city: accrual, carryover, caps, usage rules. - Paid sick policies work; state/city rules must be entered and confirmed by an advisor
- US-E05 Leave requests, approvals, calendar and team view. - Requests, approve/deny/cancel, balances, team calendar
- US-L03 Field-level encryption for SSN and bank data; key management. - SSN/ITIN, I-9 document numbers and bank account numbers are encrypted and masked

## Partial (23)

- US-A01 Country switch per company (IN / US / CA) driving currency, date, time zone, ID fields, visible modules. - Country settings and India-page gate work; no screen yet to pick the country when a company is created
- US-A02 US company profile: legal name, EIN, entity type, addresses by state, industry code, fiscal year. - EIN, entity type, address, work states saved; no industry code, fiscal year or sites
- US-A03 Multi-state / multi-location work-site model (state, county, city tax jurisdictions). - Work states per company and per employee; no work-site or city/county model
- US-A04 Hide India-only modules (PF, ESIC, PT, LWF, NPS, Gratuity) for US companies. - India menus and tabs hidden for US; a few India cards remain on the payroll Documents tab
- US-A05 USD currency and US number/date/address formatting; US time zones and DST. - USD, US dates and time zones defined and used by the clock; most old screens still show India formats
- US-A07 Role model for US: Owner, HR Admin, Payroll Admin, Manager, Employee, Accountant (read-only), Auditor. - Super admin, HR admin, manager, employee exist; no payroll admin, accountant or auditor roles
- US-A10 Audit trail on every change to people, pay and tax data. - New modules write an audit log (SSN reveal, I-9, leave, time fixes, PINs); no screen to browse it
- US-B01 Employee record (legal and preferred name, address, DOB, work state, emergency contacts). - Legal name, DOB, address, work state; no emergency contacts
- US-B05 Pay setup: hourly or salary, frequency, direct deposit split, pay schedule assignment. - Hourly/salary, rate, pay frequency and direct deposit saved; no pay schedule
- US-B10 Contractor records and 1099 data (TIN, W-9 status). - 1099 classification and taxpayer ID only; no W-9 status or contractor payments
- US-C03 Onboarding checklist builder with due dates and reminders. - US onboarding, offboarding and rehire checklists with due dates, owners and self-completing tasks, HR to-do list; fixed default tasks (HR can add custom ones), no email reminders or template editor yet
- US-D02 Timesheets with weekly approval by manager. - Timesheets by day and week; no weekly manager approval
- US-D03 Overtime engine: over 40 hours per workweek at 1.5x; state daily/double-time rules (e.g. California). - Weekly overtime over 40 shown; no daily or double-time rules, exempt staff not excluded
- US-D04 Meal and rest break rules and missed-break premiums by state. - Breaks are tracked and unpaid; no meal/rest rule checks or premiums
- US-D10 Attendance exceptions: late, missed punch, regularization. - Forgotten clock-out flag and HR missed-punch fix; no employee correction request
- US-E06 US federal holiday calendar plus company holidays. - Federal holidays are skipped in requests; no editable company holiday calendar for US
- US-E07 Balance statements and payout-at-termination rules by state. - Balances shown and a payout summary at termination; no payout calculation into pay
- US-H02 E-signature for company and employee documents. - Typed signature on W-4 and I-9 only
- US-H03 Compliance calendar (I-9 audits, new-hire reports, posters, filing dates). - W-4/I-9 deadline table; no wider compliance calendar
- US-H07 I-9 audit report and missing-document report. - Status table exists; no printable audit report
- US-I06 Exit interviews and offboarding checklist. - US offboarding checklist with an exit-conversation task; no exit-interview form or notes
- US-L01 MFA enforced for admins; SSO (SAML/OIDC) for customers. - Email one-time-code login exists; no single sign-on
- US-L02 Fix the known issues first (login bypass done; demo passwords, dependency vulnerabilities, tenant scoping on). - Login bypass and silent-save bugs fixed; demo passwords, dependency vulnerabilities, company-data scoping and one plaintext temp password remain

## Existing, not adapted (8)

- US-B03 Org chart, departments, managers, reporting lines. - Org chart, departments and managers exist from the India app; not tested for US
- US-C01 Candidate and requisition tracking, pipeline stages. - Recruitment code exists from the India app; not adapted
- US-C09 Handbook and policy acknowledgements. - Policy acknowledgements exist from the India app
- US-H08 Policy library with versions. - Policy library exists from the India app
- US-I01 Goals and reviews. - Goals and reviews exist from the India app
- US-I03 Pulse surveys and eNPS. - Surveys exist from the India app
- US-I05 Asset tracking. - Asset tracking exists from the India app
- US-J05 Custom report builder and scheduled exports. - Report builder exists from the India app

## Not started (38)

- US-A06 Effective-dated rules tables (min wage, overtime, sick leave), reviewed each January. - No dated tables for minimum wage or overtime rules (leave policies are configurable instead)
- US-A09 Data residency in a US region; backup and restore. - No US data region or backup plan yet
- US-B04 Job, title, compensation history with effective dates. - Pay rate is stored but there is no dated job or pay history
- US-B06 Custom fields and employee tags.
- US-B08 Employee self-service profile edits with approval. - People can complete their own W-4/I-9 but cannot edit their profile
- US-C02 Offer letter templates and e-signature. - Offer letters and e-signature
- US-C06 E-Verify hand-off tracking (record of case results).
- US-C07 State new-hire reporting by deadline per state.
- US-C10 Background-check provider hook.
- US-D05 Minimum-wage checks (federal, state, city) with alerts.
- US-D06 Shift scheduling, swaps, open shifts, publish to team. - Shift scheduling for US
- US-D07 Predictive-scheduling rule checks (notice windows) where required.
- US-D08 Tip and tipped-minimum-wage tracking.
- US-D11 Job/project/cost-center time allocation for ERP costing.
- US-E03 FMLA eligibility tracking and leave case management.
- US-E04 Other statutory leave (jury duty, military, bereavement, parental) by state.
- US-G01 Benefit plan catalog (health, dental, vision, 401(k), HSA/FSA). - Benefits
- US-G02 Enrollment and open-enrollment windows. - Benefits
- US-G03 Employee and employer contributions flowing to payroll. - Benefits
- US-G04 Life-event changes. - Benefits
- US-G05 401(k) provider hook (Gusto partner options) and ACA tracking data. - Benefits
- US-G06 Benefit summaries for employees. - Benefits
- US-H01 Document vault by employee and company with retention rules. - Document vault for US
- US-H04 Labor law poster and handbook state add-ons.
- US-H05 EEO-1 and demographic reporting data.
- US-H06 OSHA incident log (300/300A) basics.
- US-I02 Review cycles, 360 feedback.
- US-I04 Recognition and announcements.
- US-J01 Headcount, turnover, tenure dashboards.
- US-J02 Labor cost and overtime reports.
- US-J03 Time-off liability report.
- US-J04 Compliance status report (I-9, W-4, training).
- US-L04 State privacy features: data export and deletion requests (CCPA/CPRA).
- US-L05 Centralized logging, monitoring, alerting, backups, disaster recovery.
- US-L06 Security audit, penetration test, then SOC 2 Type I, then Type II (buyers and Gusto will ask). - Security audit, pen test, SOC 2
- US-L07 Billing and subscription (per employee per month), invoices, tax on SaaS where applicable. - Billing and subscriptions
- US-L08 Customer support tooling: impersonation with consent and audit, status page.
- US-L09 Production deployment pipeline, environments, release process. - Production deployment pipeline

## Later (Gusto/connectors) (30)

- US-D09 Hours-to-payroll export per pay period (feeds Gusto). - Hours export to the payroll provider
- US-E08 Two-way sync of time-off policies and requests with Gusto.
- US-F01 Company payroll onboarding wizard (see section 3). - Company payroll onboarding with Gusto
- US-F02 Pay schedule management. - Payroll through Gusto
- US-F03 Employee payroll profile sync (W-4, state taxes, bank, compensation). - Payroll through Gusto
- US-F04 Payroll preview: hours and pay into Gusto, calculated results back, blocker list. - Payroll through Gusto
- US-F05 Regular payroll run submit and cancel. - Payroll through Gusto
- US-F06 Off-cycle payrolls (bonus, correction, termination pay). - Payroll through Gusto
- US-F07 Contractor payments and payment groups. - Payroll through Gusto
- US-F08 Pay stubs and payroll register in our UI. - Payroll through Gusto
- US-F09 Tax filing and payment status dashboard (read from Gusto). - Payroll through Gusto
- US-F10 Year-end: W-2 and 1099 availability, corrections status. - Payroll through Gusto
- US-F11 Garnishment and deduction tracking (non-child-support garnishments need partner handling **(confirm)**). - Payroll through Gusto
- US-F12 Payroll journal / general ledger export (via Gusto report and our connector). - Payroll through Gusto
- US-F13 Historical payroll import for mid-year switchers. - Payroll through Gusto
- US-J06 Payroll cost by department/project from Gusto data.
- US-K01 Public REST API (versioned) for people, jobs, time, leave, documents, payroll results. - Connectors
- US-K02 API keys and OAuth 2.0 apps with scopes per company. - Connectors
- US-K03 Outbound webhooks with signing, retries, replay. - Connectors
- US-K04 Event bus for internal and external events. - Event bus exists from the India app
- US-K05 Connector SDK: field mapping, transforms, per-company config UI. - Connectors
- US-K06 Sync engine with change tracking, conflict rules, dead-letter queue, reconciliation reports. - Connectors
- US-K07 Bulk import/export: CSV, SFTP drops, scheduled files. - Connectors
- US-K08 Prebuilt connectors, phase 1: QuickBooks Online, Xero, NetSuite. - Connectors
- US-K09 Prebuilt connectors, phase 2: SAP, Microsoft Dynamics, Oracle, Workday Financials, Sage Intacct. - Connectors
- US-K10 Prebuilt connectors, phase 2: Slack, Microsoft Teams, Google Workspace, Okta/Entra ID (provisioning/SCIM). - Connectors
- US-K11 Automation platform listing (Zapier / Make) built on the public API. - Connectors
- US-K12 Integration health dashboard, logs, alerts, per-tenant rate limits. - Connectors
- US-K13 Developer portal: docs, sandbox company, API explorer. - Connectors
- US-K14 Partner approval flow (customer admin authorizes an app and scopes). - Connectors
