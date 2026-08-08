/**
 * Account deletion: remove follow edges, tombstone profile, delete Auth user.
 */
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const BATCH_SIZE = 500;

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.Query} query
 * @returns {Promise<number>}
 */
const deleteDocumentsInQuery = async (db, query) => {
    let deleted = 0;

    while (true) {
        const snapshot = await query.limit(BATCH_SIZE).get();
        if (snapshot.empty) break;

        const batch = db.batch();
        for (const doc of snapshot.docs) {
            batch.delete(doc.ref);
        }
        await batch.commit();
        deleted += snapshot.size;

        if (snapshot.size < BATCH_SIZE) break;
    }

    return deleted;
};

/**
 * Removes all following/follower edges for [uid].
 *
 * @param {string} uid
 * @returns {Promise<{ followingRemoved: number, followersRemoved: number, fcmTokensRemoved: number }>}
 */
export const removeUserFromFollowGraph = async (uid) => {
    const db = getFirestore();

    const followingRemoved = await deleteDocumentsInQuery(
        db,
        db.collection("users").doc(uid).collection("friends"),
    );

    const followersRemoved = await deleteDocumentsInQuery(
        db,
        db.collectionGroup("friends").where("friendId", "==", uid),
    );

    const fcmTokensRemoved = await deleteDocumentsInQuery(
        db,
        db.collection("users").doc(uid).collection("fcmTokens"),
    );

    return { followingRemoved, followersRemoved, fcmTokensRemoved };
};

/**
 * Resolves the email to retain for support audit before profile fields are stripped.
 *
 * @param {string} uid
 * @param {string | null | undefined} [emailOverride] Auth token email when available.
 * @returns {Promise<string | null>}
 */
const resolveDeletedUserEmail = async (uid, emailOverride) => {
    const normalizedOverride = emailOverride?.trim().toLowerCase();
    if (normalizedOverride) return normalizedOverride;

    const userRef = getFirestore().collection("users").doc(uid);
    const snap = await userRef.get();
    const firestoreEmail = snap.exists ? snap.data()?.email : undefined;
    if (typeof firestoreEmail === "string" && firestoreEmail.trim()) {
        return firestoreEmail.trim().toLowerCase();
    }

    try {
        const authUser = await getAuth().getUser(uid);
        return authUser.email?.trim().toLowerCase() || null;
    } catch (error) {
        if (error?.code === "auth/user-not-found") return null;
        throw error;
    }
};

/**
 * Writes a support-only audit record. Clients cannot read `accountDeletions/*`
 * (see firestore.rules); use Firebase Console or Admin SDK for lookups.
 *
 * @param {string} uid
 * @param {string | null} deletedEmail
 * @returns {Promise<void>}
 */
const recordAccountDeletionAudit = async (uid, deletedEmail) => {
    await getFirestore()
        .collection("accountDeletions")
        .doc(uid)
        .set({
            uid,
            deletedEmail: deletedEmail ?? null,
            accountDeletedAt: FieldValue.serverTimestamp(),
        });
};

/**
 * Marks a Firestore user profile as deleted and removes searchable / PII fields.
 *
 * @param {string} uid
 * @param {string | null} [deletedEmail] Email captured before PII is stripped.
 * @returns {Promise<void>}
 */
export const tombstoneUserProfile = async (uid, deletedEmail = null) => {
    await recordAccountDeletionAudit(uid, deletedEmail);

    const userRef = getFirestore().collection("users").doc(uid);
    await userRef.set(
        {
            accountDeleted: true,
            accountDeletedAt: FieldValue.serverTimestamp(),
            email: FieldValue.delete(),
            username: FieldValue.delete(),
            displayName: FieldValue.delete(),
            usernameLower: FieldValue.delete(),
            displayNameLower: FieldValue.delete(),
            searchWordPrefixes: FieldValue.delete(),
            photoUrl: FieldValue.delete(),
            photoURL: FieldValue.delete(),
            about: FieldValue.delete(),
        },
        { merge: true },
    );
};

/**
 * Permanently deletes a user account:
 * 1. Remove following / follower edges
 * 2. Delete Firebase Auth user (prevents re-login if tombstone fails later)
 * 3. Tombstone profile (strip PII + search fields) and write support audit
 *
 * @param {string} uid
 * @param {{ email?: string | null }} [options]
 * @returns {Promise<{ deleted: true, followingRemoved: number, followersRemoved: number, fcmTokensRemoved: number }>}
 */
export const deleteUserAccount = async (uid, { email } = {}) => {
    if (!uid || typeof uid !== "string") {
        const err = new Error("uid is required");
        err.statusCode = 400;
        throw err;
    }

    try {
        const deletedEmail = await resolveDeletedUserEmail(uid, email);
        const { followingRemoved, followersRemoved, fcmTokensRemoved } = await removeUserFromFollowGraph(uid);
        await getAuth().deleteUser(uid);
        await tombstoneUserProfile(uid, deletedEmail);

        console.log(
            "account-deletion: uid=%s email=%s followingRemoved=%d followersRemoved=%d fcmTokensRemoved=%d",
            uid,
            deletedEmail || "(none)",
            followingRemoved,
            followersRemoved,
            fcmTokensRemoved,
        );

        return { deleted: true, followingRemoved, followersRemoved, fcmTokensRemoved };
    } catch (deleteError) {
        console.error(
            "account-deletion: failed uid=%s error=%s",
            uid,
            deleteError?.message || deleteError,
        );
        const err = new Error(`failed to delete user account: ${deleteError?.message || deleteError}`);
        err.statusCode = 502;
        err.cause = deleteError;
        throw err;
    }
};
