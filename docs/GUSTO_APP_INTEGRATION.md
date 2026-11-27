# Gusto as an App Integration (each customer's own Gusto account)

Written 2026-11-16. This is the route chosen for the Gusto application filed by Prompt AI Ethical Solutions USA LLC: the customer keeps their own Gusto account and runs payroll there; Onn HR sends hours and people and reads results back. The older Embedded Payroll code (we create the company and run payroll inside the product) is still in the repository and still passes its tests, but it is switched off on a server set up this way.

## Settings

| Setting | Value | Notes |
|---|---|---|
| `GUSTO_INTEGRATION` | `app` | `embedded` (the default) keeps the old behaviour |
| `GUSTO_MODE` | `demo` | `mock` for the local pretend provider, `production` only after Gusto approves |
| `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET` | from dev.gusto.com | never in the repository; `.env` is ignored by git |
| `GUSTO_REDIRECT_URI` | not set locally | defaults to `http://localhost:<PORT>/api/us/gusto/oauth/callback`. In production: `https://app.onnhr.com/api/us/gusto/oauth/callback`. Must match an address registered for the application exactly. |

Both addresses above are registered for the demo application "Onn HR" at dev.gusto.com.

## What is built

**Connecting.** `services/gusto/app-connect.js`, `POST /api/us/gusto/oauth/start`, `GET /api/us/gusto/oauth/callback`, and a "Connect to Gusto" button on `admin-us-payroll.html`.

1. An owner (permission `payroll.connect`) presses Connect. The server makes a one-time `state`, stores only its hash, and returns Gusto's approval address.
2. The owner signs in to Gusto and approves. Gusto sends the browser back to the callback with a one-time code.
3. The callback has no sign-in token of ours, so it trusts only the `state`: it must be one we issued for that company, less than ten minutes old, and unused. It swaps the code for tokens, asks Gusto which company the token is for (`GET /v1/token_info`), and saves the connection. Tokens are stored encrypted, as before.
4. The browser lands back on the payroll page with a short fixed result code. Nothing Gusto or the visitor sent is echoed.

**Token renewal** already existed and now also sends the return address, which Gusto requires from an app integration.

**Refusing what an app integration may not do.** With `GUSTO_INTEGRATION=app` every `/api/us/gusto` route except status, connect, disconnect, the people list, pulling people and the error list answers 409 `app_integration`. Gusto does not let an app integration set up a company, run payroll, fetch pay stubs or tax forms, or pay contractors, so those routes would fail halfway. The payroll page hides the tabs that do not apply.

**Tests.** `tests/gusto-app-connect.test.mjs` (13 tests) runs the whole connection against the mock provider: a full connection, a reused or forged or expired state, a declined approval, a rejected code, reconnecting to a different company, and token renewal. `tests/gusto-app-connect-routes.test.mjs` (7 tests) runs the two routes themselves with stand-ins for sign-in and Firestore: who may start, the full round trip through the redirects, that nothing sent to the return address is echoed back, a declined approval, the refusal of Embedded-only actions without calling the provider, disconnect and reconnect, and that an Embedded server is unchanged. The mock provider gained `/oauth/authorize`, the `authorization_code` grant, `/v1/token_info`, and the test controls `/__mock/app-company` and `/__mock/deny-next-authorize`.

**Matching people (added 2026-11-17).** `services/gusto/time-sheets.js`, `GET /api/us/gusto/match`, `POST /match/confirm`, `DELETE /match/:userId`, and section 1 of the "Hours to Gusto" tab.

- Nothing is created in Gusto. The customer's employees are read (`GET /v1/companies/{uuid}/employees`) and each person here is tied to one of them.
- A match is suggested only when two or more of email, date of birth and full name agree with exactly one Gusto employee, and nobody else is a candidate for that employee. Gusto's "Syncing Employees" page asks for at least two of those three facts and for the user to confirm.
- Nothing is saved until someone confirms. A suggestion is not a match. The owner can also pick by hand from the list of possible people, or remove a match.
- The match keeps the Gusto employee id and the id of their primary job (it comes embedded with the employee).

**Sending hours (added 2026-11-17).** Same service, `GET /time-sheets/preview`, `POST /time-sheets/send`, `GET /time-sheets`, and section 2 of the tab.

- One Gusto time sheet per person per approved local day: `POST /v1/companies/{uuid}/time_tracking/time_sheets`, from the first clock-in to the last clock-out, with the hours split into "Regular", "Overtime" and "Double overtime" exactly as they were approved. Times are sent in UTC with the person's time zone.
- Only approved weeks are sent. Approving a week now also saves each day's hours and the start and end of work (`days` on the `timesheet_weeks` document; the start and end come from `shiftSpan()` in `services/time-rules.js`). A week approved before 2026-11-17 has no such detail and is refused with "reopen it and approve it again".
- Sending is safe to repeat. Each day sent is remembered (`gusto_time_sheets`) with a fingerprint of what was sent: unchanged days are skipped without a call, changed days are updated in place, and days that are no longer approved are removed from Gusto.
- A time sheet Gusto has already put on a payroll (`synced_to_payroll_at`) is never changed or removed; it is reported as needing an off-cycle payroll in Gusto.
- One day failing does not stop the others. Failures are listed and written to the error list, and clear when the day goes through.
- Not sent, and said so on the page: salaried people, contractors, holiday pay hours, and extra paid hours for missed breaks (a time sheet describes hours worked).
- Sending hours does not run payroll. In Gusto the owner still chooses "Sync hours to payroll" and reviews the payroll there.

**Tests for these.** `tests/gusto-time-sheets.test.mjs` (11 tests) and two more route tests in `tests/gusto-app-connect-routes.test.mjs`: the start and end of a day including work across midnight, matching rules, every reason a day is left out, create, repeat, update, remove, a time sheet already on payroll, a rejected day, a provider outage, and who may use each route. The mock provider gained the time sheet endpoints and the controls `/__mock/app-employee`, `/__mock/time-sheets` and `/__mock/time-sheet-on-payroll`.

## Added on 2026-11-17 (evening)

The five items below are on the "Hours to Gusto" tab of `admin-us-payroll.html` (steps 1 to 4) and are covered by tests against the mock provider. The tab was clicked through once in a browser on a local server with the mock provider and a fresh test company: connect, confirm matches, check again, switch automatic sending on, preview, send 14 days, put them on a payroll (refused before sending, accepted after), check with Gusto, read one payroll back, and reopen an approved week to see the hours taken back by themselves (held, because they were already on the payroll).

**Matches kept up to date.** `refreshMatches()` in `services/gusto/time-sheets.js`, `POST /api/us/gusto/match/refresh`.

- Gusto's employee list is read again and each saved match is compared with it. A changed primary job replaces the job id we send with hours.
- A person dismissed in Gusto is marked `left`: their hours are still sent (last days still have to be paid), with a warning.
- A person no longer in Gusto's list is marked `missing`: nothing is sent for them until they are matched again.
- This runs by itself at the start of every send. If Gusto cannot give its list at that moment, the days are still tried with the matches as they are.

**Sending by itself.** `setAutoSend()` and `afterWeekChange()` in the same file, `GET` and `PUT /time-sheets/settings`, and a call from `routes/time-approval.js`.

- A company setting, off by default. When on, approving, rejecting or reopening a week sends that week (Monday to Sunday of the week) at once: approved days go, days no longer approved are removed.
- The approver's answer never waits for Gusto. A failure is written to the Gusto error list (scope `auto_send`) and clears when that week goes through.
- Two sends for one company never run at the same moment (inside one server process), so two quick approvals cannot create the same day twice.
- Disconnecting switches it off.

**Hours onto a payroll.** `services/gusto/app-payroll.js`, `GET /pay-periods`, `POST /payroll-syncs`, `GET /payroll-syncs`, `GET /payroll-syncs/:id`.

- Open pay periods are the customer's regular payrolls Gusto has not processed, 45 days either side of today.
- `POST /payroll-syncs` asks Gusto to put a period's time sheets on its payroll (`POST /v1/companies/{id}/time_tracking/payroll_syncs`, kind `regular`). It is refused here, before Gusto is called, when the dates are not an open pay period, when approved hours of the period are not sent yet, or when an earlier request for the same period is still running.
- Gusto answers "pending" and finishes later. `GET /payroll-syncs?refresh=true` asks Gusto about unfinished requests and keeps the status, errors and warnings.
- This does not run the payroll. The owner still reviews and runs it in Gusto.

**Reading what was paid.** Same file, `POST /pay-results/pull`, `GET /pay-results`.

- Processed regular and off-cycle payrolls of a range (90 days back by default, a year at most) are read with their per-person taxes and kept as pay results, the rows the accounting journal and the public API already read. Reading again rewrites the same rows.
- People paid in Gusto who are not matched here are counted, not stored.
- `GET /pay-results` gives one line per payroll with totals, from our own rows.

**Disconnecting at Gusto.** `disconnect()` in `services/gusto/app-connect.js`. Gusto is asked to cancel the tokens we hold (`POST /oauth/revoke`), then they are forgotten here either way. The answer says whether Gusto was told; if not, the owner should also remove the application inside Gusto.

**Tests for these.** `tests/gusto-app-payroll.test.mjs` (8 tests), six more in `tests/gusto-time-sheets.test.mjs` and one more route test in `tests/gusto-app-connect-routes.test.mjs`. The mock provider gained payroll syncs, `/oauth/revoke`, and the controls `/__mock/app-pay-schedule`, `/__mock/app-employee-change`, `/__mock/app-payroll-processed`, `/__mock/payroll-syncs` and `/__mock/payroll-sync-result`. Two older tests were changed because the behaviour changed on purpose: a send now reads Gusto's list of people once even when no day has changed, and a stale job id is now repaired instead of rejected.

## What is NOT built yet

- **Gusto's "PayrollSync" webhook.** A finished request is noticed when the list is refreshed, not pushed to us.
- **The Embedded cost report and register in this mode.** `/payroll/cost` and `/payroll/:id/register` stay refused; `/pay-results` is the view for a customer's own Gusto account.
- **Decisions made without Gusto saying so, to check in the demo environment:** one time sheet per local day rather than per clock-in and clock-out pair; unpaid breaks left out of the hours but inside the shift's start and end; work across midnight sent as two time sheets cut at local midnight; whether Gusto accepts overlapping or back-to-back time sheets; how Gusto answers a change to a time sheet that is already on a payroll; that the unprocessed regular payrolls are the pay periods a payroll sync accepts; whether Gusto's employee list still includes people who were dismissed; whether revoking one token also ends the other.
- **Scopes.** These calls need `employees:read`, `time_sheet:read`, `time_sheet:write`, `payroll_syncs:read`, `payroll_syncs:write` and `payrolls:read`. Gusto assigns scopes during its review; the demo application's scopes have not been checked.
- **More than one server copy.** The one-send-at-a-time guard is inside one process.
- **The page has no automated test.** It was clicked through by hand once (see above), as the owner only; a read-only role was not tried in the browser.
- **Never run against real Gusto.** The only contact so far: a request to `https://api.gusto-demo.com/oauth/authorize` with a made-up application id, which redirected to Gusto's demo sign-in page, and `GET /v1/token_info` without a token, which answered 401. A person has to sign in and approve to go further.

## Trying it against Gusto's demo

1. At dev.gusto.com, create a demo company (Demo Companies).
2. Start the app locally with the Firebase emulators, as in `docs/LOCAL_TESTING.md`, on port 3000.
3. Sign in as the owner of a US company, open Payroll, press Connect to Gusto.
4. Sign in to the demo company at Gusto and approve.
5. You should land back on the payroll page with "Connected to Gusto" and the company's name in the status row.
6. Open the "Hours to Gusto" tab. Confirm the suggested matches (the demo company's employees need the same email, birth date or name as people here, or pick by hand).
7. Approve a week of hours for a matched person, choose the dates, press "Show what will be sent", then "Send to Gusto".
8. In the demo company at Gusto, look under Time & Attendance > Time Tracking for the time sheets.

If Gusto shows an error about the redirect address, the app is not running on the port the registered address names.

## Result of the first run against Gusto's demo (2026-11-17)

Run from the payroll page on a local server, against the demo company "Onn HR Test Store" and the demo application "Onn HR". The test person and their approved week were written straight into the local emulator, not made through clock punches and the approval screen.

Worked: connecting (sign in, approve, return); reading the 13 demo employees; matching by hand; creating time sheets, which Gusto marked "approved"; a repeat send that changes nothing; removing a day; a change to a day's hours; a day whose overtime disappears; a night shift sent as two back-to-back time sheets cut at local midnight; a shift longer than its paid hours (an unpaid break inside). So the demo application has `employees:read` and `time_sheet:read`/`time_sheet:write`.

Two faults found and fixed:

- **Gusto's return address was refused with "Authentication token required".** Every router attached at `/api/us` asks for a sign-in on every address under it, and they come before `/api/us/gusto`. The return address is now attached on its own in `server.js`, above those routers. The route tests did not catch it because they run the Gusto router alone.
- **A change to a time sheet was refused with "Entries do not fit in the time you entered".** An entry sent on `PUT` without its `uuid` is added to the time sheet rather than swapped in. Each entry now carries the `uuid` of the entry of the same pay classification it replaces (`entriesForUpdate()` in `services/gusto/time-sheets.js`). Gusto documents no way to drop an entry, so when a pay classification disappears the time sheet is deleted and created again. The mock provider replaces entries wholesale, so it does not reproduce this.

Still not tried against the demo: a time sheet already on a payroll, a provider outage, more than one person, and everything added after this run (refreshing matches, sending by itself, putting hours on a payroll, reading what was paid).

## Second run, through the whole product (2026-11-18)

Everything by hand on the pages of a local server, no data written directly: an employee added on the team import page (pasted from a spreadsheet, all eight columns guessed right), their first sign-in with an emailed code and a new PIN, clock in and out, the week sent for approval, the owner signing in with a PIN and approving, a match by hand, and the approved day sent to the Gusto demo company (0.07 hours, accepted). The connection made the day before still worked, so token renewal against Gusto works too.

## Sources

Gusto's App Integrations pages read on 2026-11-16 and 2026-11-17: OAuth2, Authentication, token_info reference, Syncing Time Tracking Data, Syncing Employees, Scopes, Idempotency, Jobs and Compensations, and the references for time sheets (create, list, get, update, delete), employees and payroll syncs. The time sheet and employee references name API version 2026-06-15, which this mode now sends by default. The demo environment page was empty that day. Scopes are assigned by Gusto during review and are not requested in the approval address.
