import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { releaseFcmTokenFromOtherUsers } from "../utils/notification-utils.mjs";

/**
 * Keeps a device token on a single account. Login on a shared phone used to
 * leave the previous account's `fcmTokens` doc in place, so that phone kept
 * receiving the previous account's pushes.
 */
export const onFcmTokenWritten = onDocumentWritten(
    {
        document: "users/{uid}/fcmTokens/{tokenId}",
        region: "europe-west3",
    },
    async (event) => {
        const after = event.data?.after;
        if (!after?.exists) return null;

        const token = after.data()?.token;
        const ownerUid = event.params.uid;
        if (typeof token !== "string" || token.length === 0) return null;

        const removed = await releaseFcmTokenFromOtherUsers(
            getFirestore(),
            token,
            ownerUid,
        );
        if (removed > 0) {
            console.log(
                "onFcmTokenWritten: ownerUid=%s removed=%d",
                ownerUid,
                removed,
            );
        }
        return null;
    },
);
