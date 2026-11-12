# Backups

Draft section for the deployment guide. It covers what to back up, the two ways to do it, how to restore, and where the data lives.

## What has to be backed up

| What | Where it lives | How it is backed up |
|---|---|---|
| Company and people records | Firestore | Google's managed export (preferred), or `scripts/backup.js` |
| Uploaded documents (encrypted files) | the vault folder (`VAULT_DIR`) | disk snapshot, or `scripts/backup.js` copies it |
| Sign-in accounts | Firebase Authentication | `firebase auth:export` (not part of either backup above) |
| The encryption key (`PII_ENCRYPTION_KEY`) and other settings | your secret store | kept by you, separately. **Never in a backup.** |

Without the same `PII_ENCRYPTION_KEY`, the encrypted fields (taxpayer IDs, connector credentials, webhook secrets) and the vault files in a backup cannot be read by anyone, including you. Keep the key in a secret manager with its own backup, and never in the same place as the data backups.

## Data region

The region where Firestore stores the data is chosen once, when the Firebase project's database is created. **It cannot be changed later.** For a US-only data requirement, create the project's database in a US location (a US multi-region such as `nam5`, or a single US region) before any data goes in. Moving to another region later means creating a new project and restoring a backup into it. Store backups in the same country as the data: a US bucket for the managed export, a US disk for the script.

The vault folder is wherever the server's disk is, so the server must be in a US region too.

## Preferred: Google's managed export

For anything beyond a small database, use the managed export. It runs inside Google's network, is consistent, does not load the app, and scales to any size. This is the right tool at scale; the script below is not.

1. Create a storage bucket in the same location as the database, with access limited to the backup service account.
2. Either turn on **scheduled backups** for the database in the Google Cloud console (daily or weekly, with a retention period), or schedule an export:
   `gcloud firestore export gs://<bucket>/<date> --project <project>`
3. Turn on **point-in-time recovery** for the database if you want to be able to go back to any minute in the last 7 days.
4. Restore with `gcloud firestore import gs://<bucket>/<date>` or by restoring a scheduled backup into a new database.

Check the current commands and prices in Google's Firestore documentation; they change.

## The script: `scripts/backup.js`

Use it for a small company database, for a copy you can read and check yourself, and for moving data between projects or into the local emulator. It reads every document one page at a time, so on a large database it is slow and costs one read per document (plus one request per document to look for subcollections).

```
node scripts/backup.js --out <folder>
```

It connects the same way the app does (the same Firebase credentials, or the emulator address when testing locally). It makes a new dated folder inside `--out`:

```
backup-20261112-141500Z/
  manifest.json                    counts and SHA-256 of every file
  users.jsonl                      one document per line
  organizations.jsonl
  organizations__audit_logs.jsonl  a subcollection gets its own file
  ...
  vault/                           copy of the vault folder
```

Options: `--page-size <n>` (default 300), `--only a,b` or `--exclude a,b` (top-level collection names), `--no-vault`.

What it does and does not do:

- Dates, locations, references between documents, binary values and unusual numbers are written in a marked form, so a restore gives back exactly the same values.
- It does **not** copy `.env`, keys, or service-account files, and it does not print any setting or any document content.
- Encrypted fields and vault files are copied as they are (still encrypted).
- It does **not** include sign-in accounts. Export them alongside every backup: `firebase auth:export accounts.json --project <project>`.
- It is not a point-in-time snapshot: documents changed while it runs may be saved in their old or new state. Run it at a quiet time, or use the managed export when that matters.

Store the backup folder encrypted and with limited access. It contains personal data.

## Restore: `scripts/restore.js`

```
node scripts/restore.js --from <backup folder> --project <target project id> --dry-run
node scripts/restore.js --from <backup folder> --project <target project id>
```

- `--project` is required and must match the project the credentials connect to. If they differ, nothing is written.
- Every file is checked against `manifest.json` first. If a file is missing, changed, or not listed, nothing is written.
- It **refuses to write into a database that already has data** unless you add `--force`. With `--force`, documents in the backup replace documents with the same path; documents that are not in the backup are left alone (nothing is deleted).
- `--dry-run` does all the checks, reports how many documents would be written, and writes nothing. Always run it first.
- `--only a,b` / `--exclude a,b` limit the restore to some top-level collections.
- Vault files go to the app's vault folder (or `--vault-dir <folder>`); a vault folder that already has files is left alone unless `--force` is given. `--no-vault` skips them.

After a restore:

1. Import the sign-in accounts: `firebase auth:import accounts.json --project <project>` with the hash settings from the source project.
2. Start the app with the **same** `PII_ENCRYPTION_KEY` that was in use when the backup was made.
3. Deploy the Firestore rules and indexes (`npm run deploy:firebase`); they are not part of a data backup.
4. Sign in and check a few records and one uploaded document.

## Practice the restore

A backup that has never been restored is a hope, not a backup. At least twice a year, restore the latest backup into a separate test project (or the local emulator) and check that people, time records and a document open correctly. Write down how long it took: that is your real recovery time.

## Suggested routine

| How often | What |
|---|---|
| Daily | Managed scheduled backup of Firestore, kept 7 to 30 days; disk snapshot of the vault folder |
| Weekly | Export of sign-in accounts; a longer-kept weekly backup |
| After every change of the encryption key or settings | Confirm the secret store has its own backup |
| Twice a year | Practice restore into a test project |

How long to keep backups, and the records in them, depends on your retention obligations. Confirm the periods with a US compliance advisor.
