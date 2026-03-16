/**
 * Firebase Auth admin operations using the Admin SDK.
 * Requires initializeApp() to have been called (see index.mjs).
 */
import { getAuth } from "firebase-admin/auth";

/**
 * Permanently deletes a user from Firebase Authentication.
 *
 * @param {string} uid - Firebase user UID to delete
 * @returns {Promise<{ deleted: true }>}
 * @throws {{ statusCode: number, message: string }}
 */
export const deleteFirebaseUser = async (uid) => {
    if (!uid || typeof uid !== "string") {
        const err = new Error("uid is required");
        err.statusCode = 400;
        throw err;
    }

    try {
        await getAuth().deleteUser(uid);
        console.log("google-service: user %s deleted", uid);
        return { deleted: true };
    } catch (deleteError) {
        console.error("google-service: delete-user failed error=%s", deleteError?.message || deleteError);
        const err = new Error(`failed to delete firebase user: ${deleteError?.message || deleteError}`);
        err.statusCode = 502;
        err.cause = deleteError;
        throw err;
    }
};
