# Security model

What protects customer data, who can do what, and what is still open.

## Sign-in
- Email + password with an email one-time code (MFA). Five wrong passwords lock the account for 15 minutes. Login endpoint is rate limited (10 attempts per 15 minutes per address).
- Optional company single sign-on (OIDC or SAML through Firebase Authentication). A company can require it; password sign-in is then refused except for named break-glass accounts. Settings: `admin-us-security.html`, API `/api/sso/*`.
- The old development shortcut (`?role=` and `dev_` tokens) is off unless `ALLOW_DEV_AUTH=true` on a non-production server. Demo passwords were removed from every page and script; demo buttons exist only on localhost against the local emulator.
- People whose employment has ended are refused at login and on every request, and their Firebase login is disabled at the end of the last day.
- New people get a random temporary password shown once to the administrator. It is never stored in readable form.

## Roles and permissions (`services/permissions.js`)
| Role | Can |
|---|---|
| Owner / super admin | everything, including billing, integrations, SSO, support access, role changes |
| HR admin | people, hiring, leave, benefits, compliance, reports, full SSN reveal (with a reason) |
| Payroll admin | approve timesheets, hours export, payroll provider; cannot see HR files or SSNs |
| Manager | only their direct reports (hours, time off, schedules); never themselves |
| Employee | their own information |
| Accountant | read-only payroll, labor cost, hours export, reports |
| Auditor | read-only almost everything, audit log; not confidential files or full SSNs |
| Executive | read-only company reports |
Every route checks a named permission; managers are additionally scoped to `usProfile.managerId`. Nobody can approve or decide their own request.

## Data protection
- SSN/ITIN, bank account numbers, I-9 document numbers and dependent SSNs are encrypted with AES-256-GCM, bound to the company and record (`PII_ENCRYPTION_KEY`, required in production), shown masked, and revealed only with a stated reason that is logged.
- Documents are encrypted before they are stored, outside the web root, and checked for real file type.
- EEO self-identification is stored apart from the personnel file; HR only ever sees totals.
- Every company's data is separated by `orgId` in rules and in the server. Setting `TENANT_READ_SCOPING=on` makes the server filter reads too (run `scripts/migrate-tenant-orgid.js --apply` first).
- Sensitive actions write to an audit log (`organizations/{org}/audit_logs`), viewable by owner, HR and auditors.

## Support access
Vendor support can only look at a company's data read-only, for 1 to 72 hours, after the company's owner allows it with a reason. The grant is checked on every request, every request is logged to the company's audit log, and the owner can switch it off immediately.

## Still open (be honest)
- The Content-Security-Policy still allows inline scripts (`unsafe-inline`) because many existing pages use them. Removing it needs those pages moved to external scripts.
- Dependency vulnerabilities reported by `npm audit` are tracked in `docs/DEPLOY.md`; the Excel library `xlsx` needs the vendor's patched build.
- Independent penetration test and SOC 2 are not done (see the plan).
- TOTP / hardware-key MFA is not built (email code only).
- Rules for biometric data, photos and location at the clock are data-driven and must be reviewed by counsel per state.
