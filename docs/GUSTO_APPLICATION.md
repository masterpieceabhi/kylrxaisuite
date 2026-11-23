# Gusto production approval: the application, ready to paste

Brought up to date on 2026-11-22 from `docs/GUSTO_PREAPPROVAL_DRAFT.md` (2026-11-16), today's staging run and the code.
Route: **App Integration** (each customer keeps their own Gusto account and runs payroll there). Nothing here has been
sent to Gusto. Lines marked **[YOU]** need a partner's answer; everything else is true today and can be pasted.

## 1. Product description

> Onn HR (by Prompt AI USA) is HR software for small US businesses: hiring paperwork (W-4, I-9, offer letters and
> e-signatures), a time clock with photo and work-site checks, scheduling, time off, documents and compliance reports.
> Customers who run payroll in Gusto connect their own Gusto account. Onn HR then matches its people to the Gusto
> employees, sends each approved day of hours as a Gusto time sheet, asks Gusto to put a pay period's hours on that
> period's payroll, and reads what was paid back for labor-cost reports. Customers review and run payroll in Gusto;
> Onn HR never runs payroll, holds money or moves money.

## 2. What we send and read

| Data | Direction | Endpoint family | When |
|---|---|---|---|
| Company and token info | Read | `GET /v1/token_info`, `GET /v1/companies/{id}` | On connect (fills the customer's empty company details) |
| Employees and jobs (name, email, start date, primary job, pay type) | Read | `GET /v1/companies/{id}/employees` | Matching people, before every send |
| Approved hours, one time sheet per local day | Write, update, delete | `time_tracking/time_sheets` | When a week is approved, or by hand; a changed or un-approved day is updated or removed |
| Put a period's hours on its payroll | Write | `time_tracking/payroll_syncs` | When the owner presses it; refused before calling Gusto unless all approved hours are sent |
| Pay periods and payroll results | Read | `pay_periods`, `payrolls` | Reports and checks |

We do not create companies, onboard employees, run or submit payroll, fetch pay stubs or tax forms, pay contractors
or change time-off policies (all outside App Integration scope; those routes answer 409 on our server).

## 3. Tested against the Gusto demo (true today)

- Connect with OAuth, token renewal, and disconnect (tokens revoked at Gusto, then forgotten) - 2026-11-17 and 2026-11-18.
- Matching 13 demo employees; sending, changing and removing time sheets; a repeat send changes nothing - 2026-11-17.
- Whole product by hand: employee added, first sign-in, clock in and out, week approved, hours sent - 2026-11-18.
- Several people at once: 9 daily time sheets for two people, none failed; payroll sync for Nov 14-27 accepted by
  Gusto (status success) - 2026-11-22. Gusto's warning that salaried people without overtime get no synced hours is
  now caught earlier: Onn HR warns at matching when someone is hourly here but salaried in Gusto.
- Full end-to-end run of every module against a mock of Gusto: 1,964 checks, 0 failed - 2026-11-22.

## 4. Company and contacts

- Applicant: **Prompt AI Ethical Solutions USA LLC**, 5096 W Berkshire Dr, Franklin, WI 53132. **[YOU]** state of
  registration and EIN if asked.
- Websites: https://promptaiusa.com and https://onnhr.com (privacy policy: https://onnhr.com/privacy, published).
- Primary, security and incident contact: Jagdish (Jay) Patel, jay@promptaiusa.com. **[YOU]** title and phone.
  **[YOU]** a second named person for security and incidents (a reviewer prefers two).
- General and privacy contact: support@promptaiusa.com.
- Relationship: Prompt AI develops and operates the product and is the one party responsible for privacy and security.
  Kylrx AI is a partner with no access to customer data or production systems.
- Customers today: **none, pre-launch.** **[YOU]** expected companies and employees in year one; launch date.
- Unified API platform: no, direct integration.

## 5. Security review answers

| Gusto asks about | Answer today |
|---|---|
| Hosting and data residency | United States: Google Cloud (Compute Engine, us-central1) and Google Firebase (Firestore in a US location), behind Cloudflare. The server has no open inbound port (Cloudflare Tunnel). Production is set up the same way in a new project owned only by Prompt AI. |
| Encryption in transit | HTTPS only (Cloudflare), TLS to Google and Gusto. |
| Encryption at rest | Google encrypts all stored data. In addition SSN/ITIN, bank account numbers, I-9 document numbers and dependents' SSNs are encrypted by the app with AES-256-GCM, bound to the company and record. Gusto tokens are stored encrypted and never reach the browser. |
| Authentication | Firebase Authentication. Sign-in by PIN or password; codes by email, text or WhatsApp; authenticator app (TOTP); optional company single sign-on (OIDC or SAML). Five wrong tries lock sign-in for 15 minutes; requests are rate-limited. **Multi-factor:** on a device not used before, owners, HR, payroll, accountants and auditors (the roles that can see SSNs, pay or settings) must also enter a one-time code from their authenticator app, or sent by email, text or WhatsApp; each company can extend this to everyone. Every person can set up an authenticator app in My details. |
| Password and PIN storage | PINs hashed with bcrypt; passwords held by Firebase Authentication; temporary passwords shown once, never stored readable. |
| Access control | Eight roles with named permissions checked on every route; nobody approves their own request; managers see only their own people. Tested per role. |
| Record-level authorization | Every company's data is separated by company id in the server and in the database rules (rule tests run in CI). |
| API protections | Input validation on every route, file type checks on uploads, the server refuses to serve its own code, rules, data or logs; rate limits. The Content-Security-Policy still allows inline scripts (being removed). |
| Vulnerability management | Library audit in CI: 0 known vulnerabilities on 2026-11-22. Production settings check before every start. |
| Logging and monitoring | Tamper-evident audit log per company (hash-chained); request logs; error reporting (Sentry); email alerts on failed health checks, error bursts and failed daily jobs. |
| Backups | Daily backup job and daily disk snapshots; restore tested (9,483 documents compared). A restore into a real Firebase project is part of the production set-up. |
| Vendor support access | Only with the company owner's consent, read-only, 1 to 72 hours, with a reason, logged. |
| Incident response | Policy drafted (`docs/policies/INCIDENT_RESPONSE_POLICY_DRAFT.md`). **[YOU]** adopt it (names, dates). |
| Data retention and destruction | Policy drafted (`docs/policies/DATA_RETENTION_AND_DESTRUCTION_POLICY_DRAFT.md`); retention jobs run daily. **[YOU]** adopt it. |
| Information security, physical security, vendors, personnel | Policy drafted (`docs/policies/INFORMATION_SECURITY_POLICY_DRAFT.md`). **[YOU]** adopt it. |
| SOC 2 / ISO 27001 | Not yet. |
| Penetration test | Not yet. **[YOU]** booked with: ______ for date: ______. |
| Bug bounty | None; security reports to support@promptaiusa.com. |
| Privacy laws | Employee data export and deletion built; privacy policy published. Legal review in progress. |

## 6. Before submitting (in this order)

1. **[YOU]** Fill every [YOU] above.
2. **[YOU]** Adopt the three policies (read, change what you cannot keep to, add names and today's date).
3. **[YOU]** Book the penetration test and put its date in section 5 (a booked test reads far better than "not yet").
4. Done 2026-11-22: a second step on new devices for privileged roles (section 7).
5. Submit at dev.gusto.com (the Onn HR application > request production access). Gusto replies by email; nothing more
   is needed from us until then.

## 7. A second step on a new device (built 2026-11-22)

A right PIN or password signs in. On a device the person has not used before, the roles that can see SSNs, pay or
company settings must also enter a one-time code (authenticator app when set up, else email, text or WhatsApp); the
device is then remembered. Each company chooses on its Security page: those roles (default), everyone, or nobody.
