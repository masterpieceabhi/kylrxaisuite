# Putting the app on a real server

Written 2026-11-12 for branch `feature/usa-foundation`. Read `docs/SECURITY.md` alongside this.

**What has and has not been done.** The app has only ever run on a developer PC against the Firebase emulators. It has not been deployed anywhere by the people who wrote this guide, and no hosting company has been chosen. Everything below was checked against the code; the steps that could be run locally were run (see "What was checked" at the end).

## 1. What the server needs

| Need | Why |
|---|---|
| One long-running Node process (Node 20 or newer; tested on 24.14) | The server runs background jobs in the same process: outgoing webhooks, connector schedules, the Gusto event poll, onboarding reminders and scheduled report copies. A host that only runs code per request ("serverless") will not run these. |
| **One copy only** | The background jobs and the sign-in rate limiter live in the process's memory. Two copies would send some things twice and halve the rate limit. Run one until the jobs are given a shared lock. |
| HTTPS in front, through exactly one reverse proxy | The server trusts one proxy hop (`trust proxy 1`) to learn the visitor's address for rate limits and logs. |
| A Firebase project with Authentication and Firestore | All data and logins. |
| A way to send email | The sign-in code is sent by email. Without email nobody can sign in with a password. |
| A disk folder that survives restarts and is backed up | Employee documents are stored as encrypted files in `VAULT_DIR`, not in Firebase. |

Start command: `npm start` (runs `node server.js`). The port comes from `PORT`.

### Addresses

- `onnhr.com` is the public website and stays where it is hosted now. It is a domain, not a place this server runs.
- `app.onnhr.com` is the product: this one server answers for the pages and for `/api`. Point that name at the host in DNS. The Gusto return address is already registered as `https://app.onnhr.com/api/us/gusto/oauth/callback`.
- A client app served from `app.onnhr.com` by this server is on the same address as the API, so it needs no entry in `ALLOWED_ORIGINS` and the "known device" cookie of the PIN sign-in works as it is. A client app on any other address must be named in `ALLOWED_ORIGINS`, and on a different domain (not just a different subdomain) that cookie is not sent, so the PIN would always fall back to a code.

### One server per country

The same code serves every country, and a company's own country decides its rules. What a country address decides is where the data is kept. Each server is told which countries it takes:

| Address | Settings | Database |
|---|---|---|
| `us.onnhr.com` (and `app.onnhr.com` until there is a front door) | `SERVED_COUNTRIES=US`, `COUNTRY_ADDRESSES=US=https://us.onnhr.com,IN=https://in.onnhr.com` | its own Firebase project in a US region |
| `in.onnhr.com` | `SERVED_COUNTRIES=IN`, the same `COUNTRY_ADDRESSES` | its own Firebase project in an India region |

- A company of another country is turned away at sign-up (409 `wrong_address`, with the address to use). Nothing is created.
- A sign-up that names no country gets the server's own country when it serves exactly one. A country we do not know is refused instead of being stored as India.
- `GET /api/auth/region` (public) says what this server takes and where the other countries go, for a front door or the sign-up page. The sign-up page does not use it yet.
- Not set: the server takes every country into one database, as before. `npm run check:production` warns about that.
- Only sign-up is checked. A company of another country that is already in a server's database keeps working there.
- Gusto's return address is registered for `app.onnhr.com`. Register `us.onnhr.com` with Gusto too, or keep the US server answering on `app.onnhr.com`.

### As a container

`Dockerfile` and `.dockerignore` build the server for any host that runs containers (Render, Railway, Fly.io, a VM with Docker):

```
docker build -t onnhr-server .
docker run -p 3000:3000 --env-file production.env -v onnhr-data:/data onnhr-server
```

- Run one copy only, always on (see the table above). Do not let the host scale it to zero or to two.
- Mount a disk that is kept and backed up at `/data`. Documents and clock photos go to `/data/vault`, the error log to `/data/logs`. Without the mount they are lost at every release.
- Settings come from the host's environment. No `.env` file, key file, test, doc, log or stored data file is copied into the image.
- The image leaves out the tracked `data/` and `reports/` folders (sample data and attendance reports with names). An older India page that loads a report file from `reports/` gets a 404 from the image.
- The health check calls `/api/health`.

Checked on 2026-11-18 without Docker (it is not installed on the developer PC): the exact file set the image would hold was copied to an empty folder, `npm ci --omit=dev` was run there, and the server was started with `NODE_ENV=production` against the local emulators. It answered `/api/health`, served the pages, refused `/.env`, `/server.js`, `/package.json` and `/firestore.rules` with 404, and at start listed the production settings that were missing. The image itself has not been built or run.

## 2. Settings

Set these in the host's environment. Do not put real values in a file inside the app folder. Check them on the server with:

```bash
npm run check:production
```

It lists what must be fixed and what to decide, by name only (values are never printed), and exits with an error if anything must be fixed.

### Required

| Setting | What it is |
|---|---|
| `NODE_ENV=production` | Anything else returns sign-in codes in the response and allows local test shortcuts. |
| `JWT_SECRET`, `REFRESH_SECRET` | Two different long random values (32 characters or more) that sign login sessions. |
| `PII_ENCRYPTION_KEY` | 32 random bytes as base64. Encrypts SSNs, bank numbers and stored documents. **If this key is lost, that data cannot be read again. Keep a copy somewhere safe and separate from the database backups.** |
| `AUDIT_CHAIN_KEY` | Long random value for the audit-log integrity check. |
| `FIREBASE_SERVICE_ACCOUNT` or `FIREBASE_SERVICE_ACCOUNT_PATH` | The Firebase service-account key: the JSON on one line, or the path to the file (keep the file outside the app folder). |
| `SMTP_USER` and `SMTP_PASS`, or `RESEND_API_KEY` | Email. `EMAIL_SENDER_NAME` and `EMAIL_FROM` set the sender shown. |
| `VAULT_DIR` | Folder for employee documents, outside the app folder. |

To make the random values:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use the first for `JWT_SECRET`, `REFRESH_SECRET` and `AUDIT_CHAIN_KEY` (run it three times), the second for `PII_ENCRYPTION_KEY`.

### Recommended

| Setting | What it is |
|---|---|
| `LOG_DIR` | Folder for error logs, outside the app folder. Default is `logs` inside the app folder. |
| `MONITORING_TOKEN` | Lets a monitoring service read `/api/health/deep` and `/api/metrics`. |
| `SENTRY_DSN` | Sends errors to Sentry (needs the optional `@sentry/node` package). Without it errors are only written to the log file. |
| `BUILD_ID` or `GIT_SHA` | Shown in the health check so you can tell which version is running. |
| `PUBLIC_BASE_URL` | The public address of the app, used in links the payroll provider sends people back to. |
| `TENANT_READ_SCOPING` | Leave unset. In production it is on unless set to `off`. Run `node scripts/migrate-tenant-orgid.js --apply` once first if the database holds records from before company separation was added. |

### Only if you use the feature

| Feature | Settings |
|---|---|
| Payroll through Gusto | `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `GUSTO_MODE=demo`. Real payroll also needs Gusto's approval and `GUSTO_ALLOW_PRODUCTION=true`. `GUSTO_MODE=mock` is refused in production. |
| Billing through Stripe | `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Without these billing runs in practice mode. |
| File exports from connectors | `CONNECTOR_EXPORT_DIR` (default `data/exports` inside the app folder; move it outside). |
| Vendor support access | `PLATFORM_ORG_ID`, `PLATFORM_SUPPORT_EMAILS`, `PLATFORM_OPERATOR_TOKEN`. |
| Automation builder with AI | `OPENAI_API_KEY`, `OPENAI_MODEL`. Without a key it uses the built-in rules. |
| HR assistant | `OPENAI_API_KEY` (same key), optional `ASSISTANT_DAILY_LIMIT` (questions per company per day, default 200, 0 = off). Without a key the page says the assistant is off. Company data goes to OpenAI: name it in the Privacy Policy before switching it on. |

Never set on a real server: `ALLOW_DEV_AUTH`, `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `DEV_DEFAULT_ORG_ID`, `SEED_PASSWORD`.

## 3. First-time setup

1. Create the Firebase project. Turn on Authentication (email and password) and Firestore.
2. Publish the database rules and indexes from a PC that is signed in to Firebase:
   ```bash
   npm run deploy:firebase
   ```
3. Put the code on the server and install exactly what the lock file lists:
   ```bash
   npm ci --omit=dev
   ```
4. Set the settings from section 2, then run `npm run check:production` until it reports nothing to fix.
5. Create the first owner login. A random password is printed once:
   ```bash
   npm run provision:superadmin
   ```
6. Start the server with `npm start`, behind the HTTPS proxy.
7. Check it (replace the address):
   - `https://your-address/api/health` answers `{"status":"healthy",...}`.
   - `https://your-address/server.js` and `https://your-address/logs/errors.jsonl` answer 404 (see section 6).
   - Sign in as the owner. The code must arrive by email and must **not** appear on the page.
   - Sign up a test US company, add one person, clock in and out.

## 4. Each release

1. The change is on a branch and the automatic checks are green (section 5).
2. On the server: get the new code, run `npm ci --omit=dev`, set `BUILD_ID` to the commit, restart the one process.
3. If `firestore.rules` or `firestore.indexes.json` changed, run `npm run deploy:firebase`. Publish new indexes before the code that needs them.
4. Repeat the checks from step 7 above.

**Going back.** Keep the previous release folder. To go back, point the server at it and restart. Database changes are not undone by this: a release that changes how stored records look needs its own way back, written before it ships. None of the 2026-11-11 and 2026-11-12 work changes existing records; it only adds new kinds.

## 5. Automatic checks (CI)

`.github/workflows/ci.yml` runs on every push to `main` and `feature/**` and on every pull request:

- `npm ci`, then `npm test` (all rule tests and the two server tests).
- `node scripts/static-audit.js`, which fails the tests if a page loads a file the static-file guard refuses.
- A job named `rules` starts the Firestore emulator and runs the database-rule tests (`npm run test:rules`). In the `test` job there is no emulator, so those tests are skipped there; in the `rules` job a missing emulator is a failure. This job was added on 2026-11-18 and has not run on GitHub yet; its tests pass against the local emulator.
- Another job runs `npm audit` and reports; it does not fail the build yet (see section 8).

The workflow uses throwaway secrets written in the file, for the tests only. It deploys nothing: there is no host to deploy to yet. When one is chosen, add a deploy job that runs only on `main` after `test` passes, and keep the real settings in the host, not in GitHub.

## 6. What the server will not hand out

The pages and the server code sit in the same folder, and that folder is served to browsers. `middleware/static-guard.js` runs first and answers 404 for server code, settings, database rules, scripts, tests, docs, stored data files and logs. Before 2026-11-12 these could be downloaded by anyone who knew the address, for example `/server.js`, `/firestore.rules` and `/logs/errors.jsonl`.

- A page that needs a new browser file from `services/` or `utils/` must have it added to `ALLOWED` in that file. `tests/static-guard.test.mjs` fails and names the file if this is forgotten.
- The better long-term fix is to move the pages into their own folder and serve only that folder.

## 7. Watching it and backing it up

- `/api/health`: public, answers quickly. Use it for the proxy's health check.
- `/api/health/deep` and `/api/metrics`: need `MONITORING_TOKEN` (header `x-monitoring-token`).
- Errors are appended to `LOG_DIR/errors.jsonl`. Nothing alerts anyone unless Sentry or a monitor is set up.
- **Back up three things, and test a restore:** the Firestore database (Google's scheduled export), the `VAULT_DIR` folder, and the secret values from section 2. A database backup without `PII_ENCRYPTION_KEY` cannot show SSNs, bank numbers or documents.

Backups are not scheduled by anything in this repository, and nothing alerts anyone. `npm run backup` and `npm run restore` exist for small installs and for moving data; read `docs/BACKUP.md` first. On the chosen host, run `npm run backup -- --out /data/backups` once a day from the host's own scheduler and copy that folder somewhere else.

A real restore was run on 2026-11-18, on the local emulator: a backup of the whole local database (9,483 documents in 120 collections, 5,802 of them in sub-collections, and 60 vault files) was restored into a new empty project and compared document by document. Every document was there with the same content and the same value types (dates stayed dates), and the vault files were byte for byte the same. The restore refused a wrong `--project` name and refused to write into a database that already had data. Not covered by that run: a real Firebase project, sign-in accounts (they are not in the backup), and reading encrypted fields with the key after a restore.

## 8. Known problems to fix before real customers

| Problem | Detail |
|---|---|
| Libraries with known security problems | `npm audit --omit=dev` on 2026-11-12 found 32 (2 critical, 17 high). The non-breaking `npm audit fix` was then run (only `package-lock.json` changed), which leaves 10: 0 critical, 2 high, 8 moderate. Still open: `nodemailer` (high; the fix is a major version, 10.x, so email sending must be re-tested with it), `xlsx` (high; no fix on npm, the vendor's patched build must be installed from their own site), and `firebase-admin` with the Google libraries under it (moderate; the fix is a major version, 14.x). After the update all 527 tests passed, the 39 policy and 42 equipment live checks passed, and every page file was still served. Not exercised on the updated libraries: sending real email, file uploads, and PDF creation. |
| Personal data stored in the repository | `reports/*.csv` (attendance with names and emails), `data/conversion_store.json`, `data/messages_store.json` and `logs/attendance_excel_log.csv` are tracked in git. The `reports` files are also served to browsers without a login because a page loads them. Check whether they hold real people's data; if so remove them from the repository and its history, and serve reports through a signed-in route. |
| Inline scripts are allowed | The Content-Security-Policy keeps `unsafe-inline` because many older pages need it. |
| Local demo sign-in helper | The demo password is no longer in `login.js`. The quick sign-in buttons on the login page call `/api/auth/dev-demo-login`, which exists only when both emulator settings are present and `NODE_ENV` is not `production`, and answers only to the same PC. On a real server it answers 404; check that after deploying. |
| Only one copy of the server can run | See section 1. |
| Sign-in codes by email only | No authenticator app or hardware key. |
| No independent security test | No penetration test or SOC 2. |

## What was checked for this guide

- `npm run check:production` was run on the developer PC, where it correctly reports the missing production settings. Its rules have tests.
- The static-file guard was tested over HTTP on the local server: 18 addresses of server files and logs, including upper-case and encoded forms, all answered 404, and all 267 files that the 137 pages load were still served.
- The CI steps were run by hand from a fresh copy of the repository with no local settings file (see `docs/USA_PROGRESS.md` for the result). The workflow first ran on GitHub on 2026-11-12 for the push of `feature/usa-foundation`, and both jobs passed.
- Not checked: any real host, HTTPS, real email delivery, real Firebase (only the emulators), backups and restore.
