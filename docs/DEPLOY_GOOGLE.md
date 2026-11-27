# Putting Onn HR on Google Cloud (staging first)

Written 2026-11-18. Read `docs/DEPLOY.md` (what the server needs) and `docs/BACKUP.md` alongside this.

The plan: Prompt AI's own Google project holds the database (Firestore, US) and one small server (Compute Engine,
same US region). Cloudflare Tunnel connects `app-staging.onnhr.com` to the server, so no port is open to the internet.
Email goes out through Resend on `onnhr.com`. Everything here is done once for **staging**; production is the same
steps again with a second project and `app.onnhr.com`, after staging has been used for real.

Steps marked **(you)** need your own sign-in, a payment method or an agreement to terms, so only you can do them.
Nothing in this guide was run against a real Google project when it was written: the scripts were checked for syntax
and the app change was tried on a developer PC only. Expect to correct small things on the first run.

## 1. The Google project (you)

1. Sign in at console.cloud.google.com with the Google account Prompt AI will own this with (a company account, not a
   personal one, if you have Google Workspace; otherwise one you will keep).
2. Create a project. Name: `onnhr-staging`. Note its **project ID** (it may get a number on the end).
3. Billing: link a billing account. Set a **budget alert** (Billing > Budgets) at, say, $50 a month, so a mistake
   cannot run up a bill unnoticed.

## 2. Firebase in that project (you)

1. At console.firebase.google.com: Add project > choose the existing `onnhr-staging`. Analytics: not needed.
2. **Firestore**: Build > Firestore Database > Create. Location: a US location (`nam5`, United States, or
   `us-central1`). **This cannot be changed later.** Start in production mode.
3. **Authentication**: Build > Authentication > Get started. Do **not** turn on Email/Password: people sign in with a
   PIN, a code or a QR, which do not need it, and leaving it off closes the password door completely.
4. **Web app settings**: Project settings > Your apps > Add app > Web. Name it `Onn HR`. Copy the `firebaseConfig`
   values; on the server they go into `FIREBASE_WEB_CONFIG` as one line of JSON (step 6).
5. **Server key**: Project settings > Service accounts > Generate new private key. A JSON file downloads. It is the
   key to the whole database: do not email it, do not put it in the code folder, delete the download after step 6.
   (If Google refuses because key creation is blocked by an organisation rule, tell me; the server can use its own
   Google identity instead, with a small code change.)
6. **Storage** (pay slips and uploads): Build > Storage > Get started, in the same US location as Firestore.
7. **Backups**: Firestore > Disaster recovery (or Backups): turn on daily scheduled backups (keep 14 days or more) and
   point-in-time recovery.
8. **Rules and indexes**: on this PC, from `C:\kylrxaisuite`:
   `npx --yes firebase-tools@14.27.0 login` (you sign in), then
   `npx --yes firebase-tools@14.27.0 deploy --only firestore:rules,firestore:indexes,storage --project <project ID>`

## 3. The server (you create it; the script does the rest)

1. Compute Engine > VM instances > Create. Name `onnhr-staging-1`. Region: the **same** as Firestore (for `nam5` use
   `us-central1`). Machine: `e2-small` (2 GB). Boot disk: Ubuntu 24.04 LTS, 30 GB, balanced. Firewall: leave
   HTTP and HTTPS **unticked**. Create.
2. Compute Engine > Snapshots > Create snapshot schedule: daily, keep 14 days, same region. Attach it to the VM's disk.
3. Press **SSH** next to the VM (a browser terminal opens). Use its **Upload file** button to upload the four files in
   `C:\kylrxaisuite\deploy\` (`setup-server.sh`, `onnhr.service`, `onnhr.env.template`, `install-release.sh`), then:
   `sudo bash setup-server.sh`
   It prints where the encryption key is. **Copy `PII_ENCRYPTION_KEY` into your password manager now.**
4. Upload the Firebase key file from step 2.5, then:
   `sudo mv <the file>.json /etc/onnhr/firebase-key.json && sudo chown root:onnhr /etc/onnhr/firebase-key.json && sudo chmod 640 /etc/onnhr/firebase-key.json`
   and delete the downloaded copy on your PC.
5. `sudo nano /etc/onnhr/onnhr.env`: fill in `FIREBASE_WEB_CONFIG`, `FIREBASE_STORAGE_BUCKET` (the `storageBucket`
   value), and later the email and Gusto lines.

## 4. Email: Resend on onnhr.com (you)

1. At resend.com (the account you use for BeatTheDoor): Domains > Add `onnhr.com`.
2. Add the DNS records it shows in Cloudflare (onnhr.com > DNS). Keep them **DNS only** (grey cloud).
3. When Resend says Verified: API Keys > Create, "Sending access", domain `onnhr.com`. Put it in `RESEND_API_KEY` on the
   server. Do not paste it anywhere else.

## 5. The code onto the server

1. On this PC: `bash deploy/make-release.sh`. It prints the file name and a SHA-256.
2. Upload that `.tar.gz` through the SSH window, then: `sudo bash install-release.sh <file> <sha256>`
   It refuses to switch if the settings check fails and tells you what is missing.

## 6. Cloudflare Tunnel (you)

1. Cloudflare dashboard > Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared. Name `onnhr-staging`.
2. Choose Debian, copy the install command it shows (it holds a token: paste it only into the server's SSH window).
3. Public hostname: `app-staging.onnhr.com` > service `HTTP` > `localhost:3000`.
4. Open https://app-staging.onnhr.com. You should see the Onn HR front page.

## 7. Gusto demo on staging (you)

At dev.gusto.com > Applications > Onn HR: add the redirect URI
`https://app-staging.onnhr.com/api/us/gusto/oauth/callback`, then put the demo application's client ID and secret in
the server settings and restart (`sudo systemctl restart onnhr`).

## 8. First run

Sign up a test company at `/signup.html`, add a person, clock in and out, approve, connect Gusto's demo and send the
hours: the same chain that was run on the developer PC on 2026-11-18. Watch `sudo journalctl -u onnhr -f` meanwhile.

## Day to day

| Task | How |
|---|---|
| New version | `bash deploy/make-release.sh` here, upload, `sudo bash install-release.sh ...` there |
| Go back a version | the command `install-release.sh` printed |
| See errors | `sudo journalctl -u onnhr -n 200` and `/srv/onnhr/logs` |
| Last housekeeping run | `GET /api/us/retention/schedule` as the owner |
| Settings check | `cd /srv/onnhr/app && sudo -u onnhr bash -c 'set -a; . /etc/onnhr/onnhr.env; npm run check:production'` |

## What changed in the code for this

The pages used to have the Kylrx Firebase project written into them. They now ask the server first
(`/firebase-web-config.json`, from `FIREBASE_WEB_CONFIG`) and use the built-in values only when the server names
none, which keeps local development on the emulators unchanged. The sign-in proxy follows the same project, and the
production settings check refuses to start without it.
