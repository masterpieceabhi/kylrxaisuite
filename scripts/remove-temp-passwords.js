/**
 * Removes stored plaintext `tempPassword` fields from user records (users, employees).
 * Default is a DRY RUN that only lists what it would change.
 *
 *   node scripts/remove-temp-passwords.js            dry run
 *   node scripts/remove-temp-passwords.js --apply    remove the fields
 *   node scripts/remove-temp-passwords.js --local    use the local emulators (add to either mode)
 *
 * It never prints the password values. People can still sign in with their current password;
 * use "send invite" to issue a new temporary password.
 */
const FIELDS = ['tempPassword', 'temp_password', 'temporary_password'];
const COLLECTIONS = ['users', 'employees'];

async function removeTempPasswords({ db, FieldValue, apply = false, collections = COLLECTIONS, fields = FIELDS, log = () => {} }) {
    const summary = { apply, scanned: 0, affected: 0, removed: 0, byCollection: {}, errors: [] };
    for (const name of collections) {
        let snap;
        try { snap = await db.collection(name).get(); } catch (e) { summary.errors.push({ collection: name, error: e.message }); continue; }
        summary.byCollection[name] = { scanned: snap.size, affected: 0 };
        for (const doc of snap.docs) {
            summary.scanned++;
            const data = doc.data() || {};
            const present = fields.filter((f) => data[f] !== undefined);
            if (!present.length) continue;
            summary.affected++;
            summary.byCollection[name].affected++;
            log(`${apply ? 'remove' : 'would remove'} ${present.join(', ')} from ${name}/${doc.id}`);
            if (!apply) continue;
            try {
                const patch = {};
                present.forEach((f) => { patch[f] = FieldValue.delete(); });
                await doc.ref.update(patch);
                summary.removed++;
            } catch (e) { summary.errors.push({ id: `${name}/${doc.id}`, error: e.message }); }
        }
    }
    return summary;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--local')) {
        process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
        process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
        delete process.env.FIREBASE_SERVICE_ACCOUNT;
        delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    }
    const { admin, rawCollection } = require('../config/firebase');
    const apply = args.includes('--apply');
    const rawDb = { collection: (n) => rawCollection(n) };
    removeTempPasswords({ db: rawDb, FieldValue: admin.firestore.FieldValue, apply, log: console.log })
        .then((s) => {
            console.log(JSON.stringify(s, null, 2));
            if (!apply && s.affected) console.log('Dry run only. Re-run with --apply to remove these fields.');
            process.exit(s.errors.length ? 1 : 0);
        })
        .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { removeTempPasswords, FIELDS, COLLECTIONS };
