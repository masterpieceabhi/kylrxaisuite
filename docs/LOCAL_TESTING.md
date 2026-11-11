# Run and test locally (India rules)

Everything runs on your PC against the Firebase **emulators**. Nothing touches the live `kylrxai` project.

## Start (3 terminals)

```bash
npm ci                 # once
npm run emulators      # terminal 1: local Auth (9099) + Firestore (8080); needs Java 17+
npm run seed:local     # terminal 2, after the emulators say "All emulators ready": demo org + 4 accounts
npm run start:local    # terminal 2: the app on http://localhost:3000
```

Open http://localhost:3000/login.html

| Role | Email | Password |
|---|---|---|
| Super Admin | superadmin@demo.local | LocalTest#2026 |
| HR Admin | hr@demo.local | LocalTest#2026 |
| Manager | manager@demo.local | LocalTest#2026 |
| Employee | employee@demo.local | LocalTest#2026 |

The emulator database is empty on every start; run `npm run seed:local` again after restarting it.

## The gates (what makes the app work)

1. **Login gate** - every `/api` route needs a real token (password + email one-time code, or a Firebase ID token). Dev shortcuts (`?role=` and `dev_` tokens) are off. They only work when `ALLOW_DEV_AUTH=true` and `NODE_ENV` is not `production`.
2. **Role gate** - `authorize(...)` on each route: an Employee gets 403 on admin routes.
3. **Company gate** - every read/write is limited to the caller's `orgId` (`config/tenant.js`, Firestore rules). Turn `TENANT_READ_SCOPING=on` once data is migrated.
4. **Organization setup gate** - `firestore.rules` only lets a Super Admin reach admin collections once `organizations/{orgId}.orgConfigured == true`. The seed sets it to true. A brand-new organization created at `signup.html` starts false and must finish `admin-organization-setup.html` first.

## Before any real deployment

- Set `NODE_ENV=production` (this also stops the one-time code being returned in the login response).
- Put `JWT_SECRET`, `REFRESH_SECRET` and the Firebase service account only in the host's environment.
- Remove the demo passwords and one-click demo buttons from `login.js` and `statutory-compliance.html`.
