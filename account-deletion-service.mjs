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
 * @returns {Promise<{ followingRemoved: number, followersRemoved: number }>}
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

    return { followingRemoved, followersRemoved };
};

/**
 * Marks a Firestore user profile as deleted and removes searchable / PII fields.
 *
 * @param {string} uid
 * @returns {Promise<void>}
 */
export const tombstoneUserProfile = async (uid) => {
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
 * 2. Tombstone profile (strip PII + search fields)
 * 3. Delete Firebase Auth user
 *
 * @param {string} uid
 * @returns {Promise<{ deleted: true, followingRemoved: number, followersRemoved: number }>}
 */
export const deleteUserAccount = async (uid) => {
    if (!uid || typeof uid !== "string") {
        const err = new Error("uid is required");
        err.statusCode = 400;
        throw err;
    }

    try {
        const { followingRemoved, followersRemoved } = await removeUserFromFollowGraph(uid);
        await tombstoneUserProfile(uid);
        await getAuth().deleteUser(uid);

        console.log(
            "account-deletion: uid=%s followingRemoved=%d followersRemoved=%d",
            uid,
            followingRemoved,
            followersRemoved,
        );

        return { deleted: true, followingRemoved, followersRemoved };
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
