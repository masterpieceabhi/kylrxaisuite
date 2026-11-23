# Setting up production (app.onnhr.com)

Production is built exactly like staging (`docs/DEPLOY_GOOGLE.md`), in **new accounts and with new secrets**. This page
lists only what is different or extra. Do the steps in order; each ends with a check. About one working day.

Never copy anything from staging to production: not the database, not the settings file, not the keys.

## 1. Google project and Firebase (you, in the browser)
1. console.cloud.google.com > New project: `onnhr-prod`, under a Google account that belongs to Prompt AI only.
   Billing: Prompt AI's card. IAM: only Prompt AI people; write the list down with today's date.
2. console.firebase.google.com > Add project > choose `onnhr-prod`.
3. Firestore > Create database > location **nam5 (United States)** or `us-central1`. **Cannot be changed later.**
   Production mode.
4. Authentication > Sign-in method: Email/Password on (the app uses it underneath for PINs and codes).
   Settings > Authorized domains: add `app.onnhr.com`. Settings > User account linking: **Create multiple accounts for
   each identity provider** (needed for single sign-on later).
5. Project settings > Your apps > Web app `Onn HR`: copy the config (one line of JSON) for `FIREBASE_WEB_CONFIG`.
6. Project settings > Service accounts > Generate new private key: save the file; it goes on the server only (step 3).
7. Deploy the database rules from this PC: `npx firebase-tools deploy --only firestore:rules --project onnhr-prod`.
**Check:** Firestore shows the rules tab with today's date.

## 2. Server (you, then the script)
Same as staging step 3 in `docs/DEPLOY_GOOGLE.md`, with name `onnhr-prod-1`, region `us-central1`, machine `e2-medium`
(4 GB) and a 50 GB disk. Then `sudo bash setup-server.sh`: it installs everything and **makes new random secrets on the
server** (JWT, refresh, the data encryption key, the audit key).
**Check:** `curl -s localhost:3000/api/health` says healthy.

## 3. Settings (`sudo nano /etc/onnhr/onnhr.env`)
| Setting | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://app.onnhr.com` |
| `ALLOWED_ORIGINS` | `https://app.onnhr.com` |
| `SERVED_COUNTRIES` | `US` |
| `FIREBASE_WEB_CONFIG` | the one line from step 1.5 |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `/etc/onnhr/firebase-key.json` (copy the file there, `sudo chmod 600`, owner `onnhr`) |
| `FIREBASE_STORAGE_BUCKET` | from the web config |
| `RESEND_API_KEY`, `EMAIL_FROM` | a **new** Resend key; `Onn HR <no-reply@onnhr.com>` |
| `ALERT_EMAIL_TO` | jay@promptaiusa.com and a second person |
| `SENTRY_DSN` | the **production** Sentry project |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | the upgraded, carrier-registered account and number |
| `TWILIO_WHATSAPP_FROM`, `TWILIO_WHATSAPP_CONTENT_SID` | only once WhatsApp production is approved |
| `GUSTO_INTEGRATION` / `GUSTO_MODE` | `app` / `production`, plus `GUSTO_ALLOW_PRODUCTION=true`, the production client id and secret, and `GUSTO_REDIRECT_URI=https://app.onnhr.com/api/us/gusto/oauth/callback` (register the same address at dev.gusto.com) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_PROVIDER` | live keys; `stripe`. In Stripe, add the webhook address `https://app.onnhr.com/api/billing/webhook` and copy its signing secret |
| `OPENAI_API_KEY` | a separate production key with a monthly limit |
| `MONITORING_TOKEN` | `openssl rand -hex 32` |
| `VAULT_DIR`, `BACKUP_DIR`, `LOG_DIR` | as the template, on the server disk |
| `RETENTION_AUTO` | leave off until the retention periods are confirmed by the lawyer |
Then: `sudo bash install-release.sh <release> <sha>` (it runs the settings check).
**Check:** the settings check says "Nothing that must be fixed".

## 4. The encryption key: two offline copies (you, today)
`sudo grep '^PII_ENCRYPTION_KEY=' /etc/onnhr/onnhr.env` shows it once. Write it into **two** places that are not this
server: for example a password manager entry shared by Jay and one partner, and a sealed paper copy in a safe.
Without this key every SSN and bank number is lost if the server is lost; backups do not include it.
**Check:** two people can say where the copies are.

## 5. Address (Cloudflare)
Same as staging step 6, with `app.onnhr.com` pointing at the tunnel of `onnhr-prod-1`.
**Check:** https://app.onnhr.com/api/health says healthy from your phone.

## 6. Backups and a real restore
1. Google Cloud > Firestore > Disaster recovery > Backups: daily, keep 14 weeks (or
   `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w --project=onnhr-prod`).
2. Compute Engine > Snapshots: daily schedule on the server disk, keep 14 days.
3. **Restore once**: restore yesterday's backup into a spare database (`restore-test`), open two records, delete it.
**Check:** a dated note of the restore in the launch checklist.

## 7. Monitoring
1. An outside uptime check of `https://app.onnhr.com/api/health` every 5 minutes (Google Cloud Monitoring > Uptime
   checks, free), alerting Jay's email and phone.
2. Sentry: production project; send one test error.
**Check:** stopping the service for 6 minutes (`sudo systemctl stop onnhr`, then start) sends an alert.

## 8. First run
1. Sign up Prompt AI at https://app.onnhr.com/signup.html with the real EIN and address; connect Prompt AI's real
   Gusto account.
2. Owner sets up the authenticator app; invite the team.
3. Run one or two pay periods for Prompt AI's own people before the first outside customer.
