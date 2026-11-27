const admin = require("./config/firebase-admin");
const { db } = require("./config/firebase");

async function syncBackendFirebase() {
    console.log("🚀 Syncing Firebase Backend for Nandan / Super Admin...");

    const superAdminUids = [
        { uid: "tskr05MpoYdE6J6dCilxkretDVw2", email: "superadmin@kylrx.ai", name: "Nandan" },
        { uid: "w2XWBkvIgkS9xonTqVM5wPNckav2", email: "nandanb449@gmail.com", name: "Nandan" }
    ];

    for (const target of superAdminUids) {
        try {
            // 1. Update Firebase Auth Profile & Claims
            await admin.auth().updateUser(target.uid, {
                displayName: target.name
            });
            await admin.auth().setCustomUserClaims(target.uid, {
                role: "SUPER_ADMIN",
                superadmin: true,
                permissions: ["all", "manage_payroll", "approve_batches", "override_validations", "view_unmasked_pii"]
            });
            console.log(`✅ Updated Auth user ${target.email} (${target.uid}) displayName -> "${target.name}", claims -> SUPER_ADMIN`);
        } catch (authErr) {
            console.warn(`Auth update note for ${target.email}:`, authErr.message);
        }

        try {
            // 2. Set Firestore document in 'users'
            const userRef = db.collection("users").doc(target.uid);
            await userRef.set({
                uid: target.uid,
                email: target.email,
                name: target.name,
                displayName: target.name,
                role: "SUPER_ADMIN",
                department: "Executive",
                departmentName: "Executive Management",
                status: "Active",
                lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log(`✅ Synced Firestore users/${target.uid} -> name: "${target.name}", role: "SUPER_ADMIN"`);
        } catch (dbErr) {
            console.error(`Firestore update error for ${target.uid}:`, dbErr.message);
        }
    }

    // 3. Ensure 'users/superadmin' fallback doc is also populated
    try {
        await db.collection("users").doc("superadmin").set({
            uid: "tskr05MpoYdE6J6dCilxkretDVw2",
            email: "superadmin@kylrx.ai",
            name: "Nandan",
            displayName: "Nandan",
            role: "SUPER_ADMIN",
            department: "Executive",
            departmentName: "Executive Management",
            status: "Active"
        }, { merge: true });
        console.log("✅ Synced fallback users/superadmin doc -> Nandan");
    } catch (e) {
        console.warn("Fallback doc notice:", e.message);
    }

    console.log("🎉 Backend Firebase synchronization completed successfully!");
    process.exit(0);
}

syncBackendFirebase();
