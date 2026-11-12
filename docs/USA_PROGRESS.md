# USA build progress

As of 2026-11-12 on branch `feature/usa-foundation`. Measured against the 111 functions in `USA_BUILD_PLAN.md`.

**How this was measured.** Each function was checked in the code for four things: rules or service code, a route mounted in `server.js`, a page (where the function needs one), and tests. `npm test` passes (794 tests). Run live against the local emulators, by scripts that call the real routes: everything built on 2026-11-12 (goals and reviews, surveys, equipment, policies, report builder, holiday pay and rest breaks, review rounds, news and thanks, past-payroll import, tags, pay schedules, time-off payout, the audit chain, integration alerts, notice texts, exit interviews) and payroll on the mock Gusto server (setup, one regular payroll through the page, and the extras by script). The new pages were opened in a browser to see that they load and show data; their buttons were not each clicked. Everything else is a code read, not a live run.

Status meanings: **Done** = rules, mounted route, page and tests; **Partial** = core works, the named pieces are missing; **Existing, not adapted** = old India-app code only; **Not started** = nothing.

## Totals

| Status | Count | Was (morning of 2026-11-11) |
|---|---|---|
| Done | 69 | 22 |
| Partial | 41 | 24 |
| Existing, not adapted | 0 | 8 |
| Not started | 1 | 29 |
| Later (Gusto/connectors) | 0 | 28 |
| **All** | **111** | **111** |

**The main gap now is outside accounts.** Almost everything still "Partial" is built and tested on this PC and waits for a real account or decision: Gusto demo credentials, accounting vendors, Stripe, a background-check vendor, a mail service, a host. The one "Not started" item is an independent security test (L06), which cannot be done from inside the project.

## By module

| Module | Done | Partial | Existing | Not started |
|---|---|---|---|---|
| A Platform and country | 2 | 8 | 0 | 0 |
| B People and organization | 9 | 1 | 0 | 0 |
| C Hiring and onboarding | 8 | 2 | 0 | 0 |
| D Time, attendance, scheduling | 10 | 1 | 0 | 0 |
| E Leave and holidays | 6 | 2 | 0 | 0 |
| F Payroll (Gusto) | 3 | 10 | 0 | 0 |
| G Benefits | 4 | 2 | 0 | 0 |
| H Documents and compliance | 7 | 1 | 0 | 0 |
| I Performance and engagement | 6 | 0 | 0 | 0 |
| J Analytics and reporting | 6 | 0 | 0 | 0 |
| K Connectors | 5 | 9 | 0 | 0 |
| L Security, privacy, operations | 3 | 5 | 0 | 1 |

## A. Platform and country

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-A01 | Partial | Country settings, India-page gate; signup has a country choice and a US company can sign up (no India tax numbers asked, lands on the dashboard with the US menu) | Canada; EIN is entered after signup, not during |
| US-A02 | Done | EIN, entity type, address, work states, industry code (NAICS) and the month the fiscal year starts, on the company form in `admin-us-people.html`; saving refuses a stale copy | |
| US-A03 | Partial | Locations with state, city, county (`us-org.js`), tests, page `admin-us-org.html` | Tax-jurisdiction mapping |
| US-A04 | Partial | India menus hidden for US | A few India cards may remain on the payroll Documents tab (not confirmed) |
| US-A05 | Partial | `country-format.js` included in about 37 old pages | Not checked that every screen uses it |
| US-A06 | Partial | Dated minimum-wage rules with history and a page | Overtime, meal-break and sick-leave rules are company settings, not dated state tables |
| US-A07 | Partial | Eight roles in `permissions.js`, role routes, tests, role page in `admin-us-owner.html`. Sign-in now sends each US role to a working page: owner to the dashboard, employees to the clock, everyone else to `us-home.html` (a menu built from their permissions). Before this, payroll admins, accountants, auditors and executives could not sign in, and HR admins, managers and employees landed on India pages | `us-hr.js` now uses permissions (tests cover all eight roles on each route; auditors can now read the people list and profiles, as their role says). `us-people.js` and `us-offboarding.js` still use the old role check |
| US-A08 | Done | SSN/ITIN encryption, masking, reveal with reason | |
| US-A09 | Partial | `npm run backup` and `npm run restore` (`scripts/backup.js`, `scripts/restore.js`): every collection to files with a checksum list, plus the document folder; restore refuses a database that is not empty unless forced, and has a dry run. `docs/BACKUP.md`. Tests prove a full round trip in memory; backup and a restore dry run were run on the emulator | A real restore was never run; sign-in accounts and the encryption key are not in the backup; no schedule; data region is chosen when the Firebase project is made and is not chosen yet; Google's managed export is the right tool at scale |
| US-A10 | Partial | Audit list, CSV and chain check routes, viewer in `admin-us-owner.html`. The main audit writer now writes the tamper-evident chain; a chain failure never fails the request (the entry is saved unchained and the problem logged). Checked live | Direct writers in `api-v1.js`, `sso.js`, `support-access.js` and `time-approval.js` are still unchained (shown as such); chained writes go one at a time per company, about 130 ms each on the emulator; changing the integrity key makes old entries fail the check |

## B. People and organization

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-B01 | Done | Profile, preferred name and emergency contacts; employee page `my-profile.html` (English and Spanish); HR view in `admin-us-changes.html` | |
| US-B02 | Done | W-2 vs 1099, exempt vs non-exempt | |
| US-B03 | Done | Departments, managers, org chart, bulk reassignment; page `admin-us-org.html` | |
| US-B04 | Done | Job and pay history with approval, tests, page `admin-us-pay.html` | |
| US-B05 | Done | Pay schedules (`admin-us-org.html`), direct-deposit splits (`admin-us-pay.html`), tests | Split accounts are not sent to Gusto; employees cannot set splits themselves on a page |
| US-B06 | Done | Custom fields, tests, page `admin-us-changes.html` with a Show button for sensitive values (asks for a reason, recorded, hidden again after 30 seconds); employees fill theirs in `my-profile.html`. Tags: a company tag list (up to 50), tags on a person, and a tag filter on the people list; employees do not see tags. Checked live | |
| US-B07 | Done | Bulk import with check-first step | |
| US-B08 | Done | Self-service change requests with approval; employee page `my-profile.html`, HR queue `admin-us-changes.html` | Supporting-document upload is not on the page |
| US-B09 | Done | Termination and rehire | |
| US-B10 | Partial | W-9, 1099 payment ledger, annual summary, tests, page `admin-us-pay.html` | Filing 1099s or paying contractors through Gusto |

## C. Hiring and onboarding

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-C01 | Done | Requisitions, pipeline, scorecards, interviews, hire; HR page `admin-us-hiring.html`; public careers and apply page `careers.html` (English and Spanish); tests | Sending the offer for e-signature from the page (waits on the e-sign pages) |
| US-C02 | Done | Offers, e-sign templates and requests; HR page `admin-us-esign.html`; public signing page `sign.html` (English and Spanish); a signed offer letter marks the offer accepted; tests | The signing link is shown to HR to pass on; the system does not email it |
| US-C03 | Partial | Onboarding, offboarding, rehire checklists; page `admin-us-checklists.html` with the open-task list and an editor (add your own tasks, switch off optional built-in ones; form and required tasks stay), tests | Email reminders |
| US-C04 | Done | Federal W-4 | State withholding forms |
| US-C05 | Done | I-9 Sections 1 and 2 | |
| US-C06 | Done | E-Verify case tracking, tests, page `admin-us-hiring-compliance.html` | Tracking only: cases are created on the E-Verify website by hand |
| US-C07 | Done | New-hire reporting list, state agency table, export, tests, page `admin-us-hiring-compliance.html` | The state filing itself is manual; the file download was not run live with a real SSN on record |
| US-C08 | Done | Direct deposit form | |
| US-C09 | Done | Handbook acknowledgement template, sent from `admin-us-esign.html`, signed on `sign.html`, listed for the employee in `my-documents.html` | |
| US-C10 | Partial | Background-check workflow (FCRA steps), tests, page `admin-us-hiring-compliance.html` | Only a mock provider (a real vendor needs a contract and key); permission is recorded as paper only on the page |

## D. Time, attendance, scheduling

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-D01 | Done | Clock in/out, kiosk; new consent, selfie and geofence policy on the server; rules page `admin-us-clock.html`; `punch.html` shows notices, takes the photo and explains work-site blocks; the shared kiosk (`kiosk.html`) does the same | Taking a photo could not be tested (the test browser blocks the camera) |
| US-D02 | Done | Weekly timesheets and approval | |
| US-D03 | Done | Overtime engine | |
| US-D04 | Done | Meal-break check from the punches; rest breaks as a company setting (one per so many hours), confirmed by the person each week when they send their hours, with the missed days flagged for the approver; optional extra paid hours per day for a missed meal break and for a reported missed rest break. All are company settings on `admin-us-time.html`, off by default, with tests; run live through the timesheet page | Rest breaks are the person's own report, not measured from the clock; the settings are one set per company, not per state or location; premium hours are paid at the regular rate and sent to Gusto inside regular hours |
| US-D05 | Done | Minimum-wage checks with a page, linked in the menu | |
| US-D06 | Done | Shifts, publish, open-shift claims, swaps, availability, tests; pages `admin-us-schedule.html` and `my-schedule.html` (English and Spanish) | Shift templates and one-day availability exceptions have no screen; a manager can approve their own request |
| US-D07 | Done | Predictive-scheduling rules and premium report, on the Rules and "Planned and worked" tabs of `admin-us-schedule.html` | Premium amounts are listed only, not sent to payroll |
| US-D08 | Done | Tips and tip pools, employee page, linked from the clock page | |
| US-D09 | Partial | CSV hours export; hours feed into Gusto with a page | Proven on the mock Gusto only |
| US-D10 | Done | Punch corrections | |
| US-D11 | Done | Jobs, time allocation, report, tests; Jobs tab in `admin-us-schedule.html`, "Which job I worked on" in `my-schedule.html` | Charging one clock period to a job from the clock page |

## E. Leave and holidays

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-E01 | Done | PTO policies and accrual | |
| US-E02 | Done | Paid sick policies | State and city rules must be entered and confirmed |
| US-E03 | Done | Leave cases (FMLA style), HR and employee pages, linked | |
| US-E04 | Done | Jury, military, bereavement, parental leave types | State rules are placeholders to be entered |
| US-E05 | Done | Requests, approvals, calendar | |
| US-E06 | Done | Company holiday routes, tests, page (`admin-us-org.html`); time-off requests skip the company's holidays; timesheets show the company holidays in the week. Holiday pay is a company setting (hours per paid holiday; everyone or full-time only; hourly staff only): the hours are added to the week on top of hours worked, never count toward overtime, appear in the hours export, and go into the payroll feed | Holiday hours reach Gusto inside regular hours (same pay, not listed separately on the stub); a higher rate for working on a holiday is not calculated; no rule such as "must work the day before and after" |
| US-E07 | Partial | Balances and payout summary. Payout of unused time: amount worked out from the policies marked "paid out" and the pay rate, request, approval by payroll (not your own), marked paid (which takes the hours off the balance), list and CSV for payroll; section on `admin-us-leave.html`. Whether unused time must be paid is a company setting. Checked live | The approved amount is not put into a Gusto pay run by the app; payroll enters it (for example as final pay on an off-cycle payroll) |
| US-E08 | Partial | Approved leave pushed to Gusto | One way only; no policy sync; mock only |

## F. Payroll through Gusto

All of F runs against the mock Gusto server only. A real run needs Gusto demo credentials (`GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `GUSTO_MODE=demo`); production also needs Gusto's approval and `GUSTO_ALLOW_PRODUCTION=true`. Routes: `routes/us-gusto.js` at `/api/us/gusto`, public webhook receiver at `/api/webhooks/gusto/:orgId`. Pages: `admin-us-payroll.html`, `my-pay.html`. Tests: 20 service-level tests against the mock; the routes were checked live (44 checks), not by an automated test file.

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-F01 | Partial | 14-step company setup with a page. Run again on 2026-11-12 on the mock, through the page: connect, all 15 steps to "Approved", then one weekly payroll prepared and submitted, and the register read in the browser (1 person, 26.5 hours, $490.25 gross) | Real Gusto credentials; state-tax fields are the mock's, to verify against Gusto; a person must have a W-4 on file before Gusto will mark them finished, and the page only says so after the step fails |
| US-F02 | Done | Pay schedule sent to Gusto from the setup page; local page `admin-us-pay-schedule.html` shows each schedule with its next 6 periods and pay dates, checks a draft before saving, edits and deletes. Checked live | The Gusto setup step takes its own input and is not filled in from the local schedule |
| US-F03 | Partial | People, address, job, pay and federal W-4 sent; compare with Gusto. Bank details and state tax answers now go with the people sync (bank numbers decrypted only at send time); a state-tax form on the People tab | Mock only. Bank details were not sent in the live run (no demo person has any) and the mock asks no state questions for the demo state; a split that mixes amounts and percents is not sent; people classed 1099 are synced only as contractors (F07) |
| US-F04 | Partial | Hours feed, prepare, preview, blockers, deadline warning, page | Real Gusto credentials |
| US-F05 | Partial | Submit with typed confirmation, stale-hours and double-submit guards, cancel | Real Gusto credentials |
| US-F06 | Partial | Off-cycle payroll (bonus, correction, final pay) for chosen people, then the same preview, typed confirmation, submit and cancel as regular payroll; tab on `admin-us-payroll.html`. Run live on the mock: one discarded, one submitted | Mock only; request shapes are marked "verify against Gusto" in the code; final pay is sent as "Severance", which may be the wrong line for unused time off |
| US-F07 | Partial | Contractors sent to Gusto, payments recorded, listed and cancelled; each payment is written to the 1099 ledger exactly once and voided on cancel. Run live on the mock | Mock only; payments are recorded as paid by check (the company pays the contractor itself), no contractor direct deposit |
| US-F08 | Done | Pay stubs (admin and employee page), payroll history, and a payroll register and cost view from pay results stored at submit (`services/gusto/pay-results.js`, tests) | Proven on the mock Gusto only. The mock gives no per-person taxes, so company tax totals are shared out by gross pay and marked as estimates; real Gusto data uses its own per-person figures |
| US-F09 | Partial | Tax payments and forms read from Gusto, shown on the page | |
| US-F10 | Partial | W-2 and 1099 lists read from Gusto, years per person on the payroll page, "My tax forms" on `my-pay.html` (English and Spanish); PDFs come through the server. Run live on the mock | Mock only; form names are matched loosely and need checking against real Gusto |
| US-F11 | Partial | Garnishments: record a court-ordered deduction (type, case number stored encrypted, amount or percent, company-entered limit, dates), send to Gusto, end it. No built-in legal limits. Run live on the mock | Mock only; nothing starts or ends an order on its date by itself, the list says when to act |
| US-F12 | Partial | Journal builder and accounting adapters; pay results are now stored, so the journal has data to read | Never run end to end against a real accounting system |
| US-F13 | Done | Past payroll from a CSV: check (saves nothing, errors per row), confirm (all or nothing), list of imports, undo one import; page `admin-us-payroll-import.html`. Imported pay is marked as imported and counts in the cost report, the public API and the accounting journal. Checked live | Imported pay does not show in the per-payroll register or on employee pay stubs (both read Gusto); the accounting journal would post it unless told to skip imports |

Known decision to make: a person who is in Gusto but has not finished onboarding there is left off the payroll with a warning, and the payroll can still be submitted. Consider making that a blocker.

## G. Benefits

Server code, mounted routes and tests exist for all six. Pages: `admin-us-benefits.html` (HR) and `my-benefits.html` (employee, English and Spanish). ACA hours and offers, and COBRA tracking, are tabs on the HR page.

| Id | Status | What is missing |
|---|---|---|
| US-G01 | Done | |
| US-G02 | Done | Employee self-enrollment was not run in the browser with an eligible employee (the seeded test logins are not W-2 with a start date); HR-entered enrollment was |
| US-G03 | Partial | The deduction feed is shown, downloads as CSV, and can be sent to Gusto with a preview of what will change and a compare afterwards. Mock only, and the live run had nothing to send (no demo person is enrolled); a 401(k) company match is sent as a dollar estimate, not a real match setup |
| US-G04 | Done | |
| US-G05 | Partial | 401(k) provider hook; the carrier adapter is a stub |
| US-G06 | Done | |

## H. Documents and compliance

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-H01 | Done | Document vault | Retention jobs have no page or test |
| US-H02 | Done | E-sign service, certificate, tests; pages `admin-us-esign.html`, `sign.html`, "to sign" list in `my-documents.html` | |
| US-H03 | Done | Deadline and expiry lists; `admin-us-calendar.html` puts every dated duty in one list (I-9, documents, E-Verify, new-hire reports, background checks, privacy requests, COBRA, benefits, signing links, workplace notices) | Built in the page from the existing lists, so it shows only what the signed-in role may see |
| US-H04 | Partial | Notice tracker; three federal starting drafts (FMLA, COBRA general notice, Marketplace notice) the company can edit, with versions, a review record and attach-to-notice, on the compliance page. Checked live | The drafts are not legal text until a US compliance advisor reviews them (each shows a banner until then); no state notices or state lists |
| US-H05 | Done | EEO-1 data | |
| US-H06 | Done | OSHA log | |
| US-H07 | Done | I-9 status table; printable audit report `admin-us-i9-report.html` for current and former employees with on-time checks, reverify dates and keep-until dates, CSV, tests | |
| US-H08 | Done | Policy library with numbered versions, rules, routes and tests; HR page `admin-us-policies.html` (draft, publish, small-fix publish, archive, who has read it with CSV, old versions), employee page `my-policies.html` (English and Spanish, phone size: read and confirm). A new version asks everyone again unless it is published as a small fix; one stored confirmation per person per version, never changed. Run live: 39 route checks and both pages | The system supplies no policy text (on purpose); policy text is plain text only, no file upload or formatting; no email when a policy is published or still unread; no due date for confirming; the policy text itself is written in one language |

## I. Performance and engagement

| Id | Status | What is missing |
|---|---|---|
| US-I01 | Done | Goals and written reviews with rules, routes and tests; manager and HR page `admin-us-performance.html`, employee page `my-goals.html` (English and Spanish). Run live: goal added and shown late, review shared, employee marked it seen, private note not sent to the employee. Missing: no email when a review is shared; only HR was tried live, not a manager with their own team |
| US-I02 | Done | Review rounds with self review, manager review and coworker (360) feedback: rules, routes, tests; HR and manager page `admin-us-review-cycles.html`, employee page `my-reviews.html` (English and Spanish). Coworker answers are stored without the giver and shown only when 3 or more answered. Checked live (74 checks). Missing: an open round cannot be changed (no new due date, no adding a new hire); feedback is readable while the round is open once 3 have answered, so a later answer could be guessed by comparing; no email |
| US-I03 | Done | Pulse surveys and eNPS with rules, routes and tests; HR page `admin-us-surveys.html` (two starter templates, draft, open, close, results), employee page `my-surveys.html` (English and Spanish, phone size). Answers are stored without a user id; one answer per person; results show only after the survey is closed and the minimum number of answers (3 or more) is reached, per question too. Run live: 33 route checks and both pages. Missing: no email or notice when a survey opens; everyone in the company gets every survey (no per-location or per-department audience); no comparison between surveys over time; managers see no results at all; "anonymous" holds inside the app, not against someone with direct database access |
| US-I04 | Done | Announcements (everyone, a location or a department; pin, end date, who has read it) and thanks between coworkers (company values, daily limit, HR can hide one): rules, routes, tests; HR page `admin-us-recognition.html`, employee page `my-news.html` (English and Spanish). Checked live (64 checks). Missing: no email or phone notice; a login with no employee profile sees only "everyone" news and cannot be thanked |
| US-I05 | Done | Company equipment with rules, routes and tests; HR page `admin-us-assets.html` (add, give, take back, repair, lost, retire, history, CSV, a list of items still with people who have left), employee page `my-assets.html` (English and Spanish, phone size: confirm "I have this", report a problem). Managers see their own team's items read-only; the holder never sees cost, HR notes or history. Run live: 42 route checks and both pages. Missing: not tied to the onboarding and offboarding checklists (the "collect equipment" task is still ticked by hand); no email when an item is given or late; no bulk import; no photos or signed hand-over form; the manager view was checked through the routes, not in the browser |
| US-I06 | Done | Exit interview: HR-editable questions (English and Spanish defaults), the leaver fills it on `my-exit-interview.html` until the last day, HR and owner only (never the manager), reasons-for-leaving summary with CSV on `admin-us-exit-interviews.html`. Checked live. Missing: the summary shows reasons even when only one person answered (the page warns) |

## J. Analytics and reporting

| Id | Status | What is missing |
|---|---|---|
| US-J01 to US-J04 | Done (4) | |
| US-J05 | Done | Report builder `admin-us-report-builder.html` over four data sets (people, equipment, goals, policy confirmations): choose columns, conditions, sort and a count-by column; CSV download; saved reports; a weekly or monthly schedule that keeps dated CSV copies on the page (newest 12). Pay columns only for roles that may see pay; no taxpayer numbers in any data set. Rules, routes, tests; 31 live route checks and the page. Missing: copies are kept on the page, not emailed or sent to a folder; no data sets yet for hours, time off or payroll (the standard reports cover those); no charts beyond the count bars |
| US-J06 | Done | Payroll cost by department and pay date from stored pay results, on the payroll page | Mock Gusto only |

## K. Connectors and API

Routes now mounted: `/api/us/integrations`, `/api/v1`, `/oauth`, `/scim/v2`. The webhook delivery worker and the connector scheduler now start with the server. Page: `admin-us-integrations.html` (keys, webhooks, OAuth apps, SCIM tokens, connectors, API activity). Checked live: 30 checks. No automated tests for the connectors, the sync engine or SCIM.

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-K01 | Partial | Public API v1 (people, jobs, org, time, leave, documents), OpenAPI document | Pay results fill in once a payroll is submitted through Gusto; documents are metadata only |
| US-K02 | Done | API keys and OAuth apps with a page; `oauth-consent.html` where the owner approves an app | After signing in, the owner must reopen the app's link (login has no return address) |
| US-K03 | Partial | Signed webhooks, retries, replay, page | |
| US-K04 | Done | Event outbox; person, leave, timesheet, document and payroll events are sent | Only the document-signed event was watched going out live; the others are the same one-line call |
| US-K05 | Done | Adapter base, field mapping, preview route, a mapping screen per connection on the integrations page, tests | A mapping that could write into built-in object internals (`__proto__`) was found by the new tests and is now refused |
| US-K06 | Partial | Sync engine, runs, error retry, reconciliation, now with tests. The tests found and fixed four faults: open errors never cleared after a good run, the cursor moved past a failed record, the schedule stopped for good after one failed run, and retry marked a record retried when the run did not start | Detail screens; never run against a real system |
| US-K07 | Partial | File export to a local folder, with tests (a file-export connection can now be made without SFTP details) | SFTP is tested only with a stand-in client (the library is not installed) |
| US-K08 | Partial | QuickBooks, Xero, NetSuite adapters | Never run against the real services; journal source data is empty |
| US-K09 | Partial | SAP, Dynamics, Oracle, Workday, Sage adapters | Same |
| US-K10 | Partial | Slack, Teams, Google Workspace adapters; SCIM server, now with tests (list, get, create, change, deactivate, filters, company separation) | Real credentials |
| US-K11 | Partial | Trigger, hook and action endpoints | The Zapier/Make listing itself |
| US-K12 | Done | Overview and API activity on the page; rate limits; alerts when a connection fails several runs in a row or a webhook address keeps failing, shown on the integrations page with acknowledge and company-set limits. Checked live | Alerts show on the page only, no email |
| US-K13 | Partial | OpenAPI document | Docs site, sandbox company, API explorer |
| US-K14 | Done | Authorize and grant routes, `oauth-consent.html` | |

## L. Security, privacy, operations

| Id | Status | What exists | What is missing |
|---|---|---|---|
| US-L01 | Partial | Email one-time code; SSO service, routes and settings page (now linked) | SSO depends on Firebase Identity Platform setup (not verified); no TOTP |
| US-L02 | Partial | Login bypass fixed; tenant read scoping on in production; the server no longer hands out its own source, database rules, scripts, stored data files or logs as static files (`middleware/static-guard.js`, with a test that fails if a page needs a blocked file); `npm run check:production` checks a server's settings before start; `docs/DEPLOY.md` written | `npm audit`: the non-breaking fixes were applied on 2026-11-12 (32 findings down to 10, none critical); `nodemailer`, `xlsx` and `firebase-admin` still need a major upgrade or a vendor build (see `docs/DEPLOY.md`); personal data in tracked files under `reports/`, `data/` and `logs/`; inline scripts allowed; the demo password is no longer in `login.js` (the local quick sign-in buttons ask a helper that exists only on a developer PC with the emulators) |
| US-L03 | Done | Field-level encryption | |
| US-L04 | Done | Privacy export and deletion, tests; pages `admin-us-privacy.html` and `my-privacy.html` (English and Spanish) | |
| US-L05 | Partial | Request logs, metrics, deep health check; backup and restore scripts (see A09) | Alerting, scheduled backups, a tested restore |
| US-L06 | Not started | | Security audit, pen test, SOC 2 |
| US-L07 | Partial | Billing rules, service, Stripe adapter, tests, page in `admin-us-owner.html` (practice mode with test cards) | Real Stripe never exercised; no real card entry; tax is a placeholder |
| US-L08 | Done | Support access with consent and audit; status endpoint; public page `status.html`; platform staff screen `admin-support.html` listing support-access grants (closed unless the platform settings name the user) | The staff screen was not opened as platform staff in a browser |
| US-L09 | Partial | CI workflow `.github/workflows/ci.yml` (install from the lock file, all tests, static-file check, library audit report). Its steps were run by hand from a fresh copy of the repository and passed, and the workflow passed on GitHub on 2026-11-12 (both jobs) | Nothing deploys automatically because no host is chosen; no separate test and live environments |

## Next, in order of value (no outside accounts needed)

1. Done on 2026-11-12: holiday pay hours, rest breaks and missed-break pay (D04, E06), as company settings.
2. Done on 2026-11-12: US versions of the old India modules: goals and reviews (I01), surveys (I03), equipment (I05), policy library (H08), report builder (J05).
3. Done on 2026-11-12: `docs/DEPLOY.md`, the static-file guard, the production settings check and the CI workflow (L02, L09). Choosing a host and deploying is still open.
4. Done on 2026-11-12: the Gusto setup and one payroll were run on the local mock through the page (F01).
5. Done on 2026-11-12 (second round): review rounds and 360 feedback (I02), news and thanks (I04), exit interviews (I06), past-payroll import (F13), tags (B06), industry code and fiscal year (A02), local pay-schedule page (F02), time-off payout (E07), the audit chain in the main writer (A10), permissions in `us-hr.js` (A07), connector and SCIM tests (K05, K06, K07, K10), integration alerts (K12), status page and support screen (L08), backup and restore scripts (A09), notice drafts (H04), and on the mock Gusto: off-cycle payrolls, contractor payments, W-2 and 1099 lists, garnishments, benefit deductions, bank and state tax (F06, F07, F10, F11, G03, F03).
6. Email: checklist reminders, signing links, and notices for new surveys, policies, equipment, announcements and review rounds (needs a mail service decision).
7. Finish the library findings: major upgrades of `nodemailer` and `firebase-admin`, and the vendor's build of `xlsx`. The non-breaking fixes were applied on 2026-11-12. Re-test email, file uploads and PDF creation on the updated libraries.
8. Take the personal data out of the tracked files under `reports/`, `data/` and `logs/`, and serve attendance reports through a signed-in route.
9. Choose a host, then follow `docs/DEPLOY.md`. Only one copy of the server can run until the background jobs share a lock.
10. Get Gusto demo credentials and check every place marked "verify against Gusto" in `services/gusto/` (off-cycle, contractors, forms, garnishments, benefits, bank and state tax).
11. Have a US compliance advisor review the notice drafts and the company-set rules.

Needs an outside account before it can move: Gusto demo credentials (all of F), accounting vendor sandboxes (K08, K09), Stripe test keys (L07), a background-check vendor (C10).
