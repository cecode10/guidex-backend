import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";

/** Named Firestore DB for users, friends, posts (see firebase.json → firestore). */
const SOCIAL_FIRESTORE_ID = "social-network";

/**
 * Cloud Function to handle "Data Fan-out".
 * When a user updates their profile (username, displayName, photoUrl, photoURL),
 * we need to denormalize this data by updating all of their past posts.
 */
export const onUserProfileUpdate = onDocumentUpdated(
    { document: "users/{uid}", database: SOCIAL_FIRESTORE_ID },
    async (event) => {
        const oldData = event.data.before.data() || {};
        const newData = event.data.after.data() || {};

        const usernameChanged = oldData.username !== newData.username;
        const displayNameChanged = oldData.displayName !== newData.displayName;
        const photoUrlChanged = oldData.photoUrl !== newData.photoUrl;
        const photoURLChanged = oldData.photoURL !== newData.photoURL;

        if (!usernameChanged && !displayNameChanged && !photoUrlChanged && !photoURLChanged) {
            return null; // Nothing relevant changed
        }

        const uid = event.params.uid;
        const newName = newData.username || newData.displayName || uid;
        const newAvatar = newData.photoUrl || newData.photoURL || null;

        const db = getFirestore(SOCIAL_FIRESTORE_ID);

        // Query all posts by this author
        const postsRef = db.collection("posts").where("authorId", "==", uid);
        const postsSnapshot = await postsRef.get();

        if (postsSnapshot.empty) {
            console.log(`No posts found for user ${uid}.`);
            return null;
        }

        // Execute batch update
        // Note: Firestore limits batches to 500 operations.
        // We'll chunk them just in case the user has many posts.
        const batches = [];
        let currentBatch = db.batch();
        let currentBatchCount = 0;
        let totalUpdated = 0;

        for (const doc of postsSnapshot.docs) {
            currentBatch.update(doc.ref, {
                authorName: newName,
                authorAvatar: newAvatar,
            });
            currentBatchCount++;
            totalUpdated++;

            if (currentBatchCount === 500) {
                batches.push(currentBatch.commit());
                currentBatch = db.batch();
                currentBatchCount = 0;
            }
        }

        // Commit any remaining operations in the last batch
        if (currentBatchCount > 0) {
            batches.push(currentBatch.commit());
        }

        await Promise.all(batches);
        console.log(`Successfully updated ${totalUpdated} posts for user ${uid}.`);

        return null;
    },
);
