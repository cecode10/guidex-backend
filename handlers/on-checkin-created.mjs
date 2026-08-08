import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import {
    ALWAYS,
    NEW_CHECKINS_SETTING,
    displayNameFromUserDoc,
    extractNotificationSetting,
    followerIdsOf,
    matchesBinaryPolicy,
    sendPushToUser,
} from "../utils/notification-utils.mjs";

/**
 * Notifies followers when a user publishes a new check-in.
 */
export const onCheckinCreated = onDocumentCreated(
    {
        document: "users/{authorId}/checkins/{checkInId}",
        region: "europe-west3",
    },
    async (event) => {
        const { authorId, checkInId } = event.params;
        const checkInData = event.data?.data();
        if (!checkInData) return null;

        const db = getFirestore();
        const messaging = getMessaging();

        const authorDoc = await db.collection("users").doc(authorId).get();
        const authorName = displayNameFromUserDoc(authorDoc.data(), authorId);
        const locationName = typeof checkInData.locationName === "string"
            ? checkInData.locationName
            : "a new place";

        const followerIds = await followerIdsOf(db, authorId);
        if (followerIds.length === 0) return null;

        let totalSent = 0;

        for (const followerId of followerIds) {
            if (followerId === authorId) continue;

            const followerDoc = await db.collection("users").doc(followerId).get();
            const setting = extractNotificationSetting(
                followerDoc.data(),
                NEW_CHECKINS_SETTING,
                ALWAYS,
            );
            if (!matchesBinaryPolicy(setting)) continue;

            const sent = await sendPushToUser(db, messaging, followerId, {
                title: "New check-in",
                body: `${authorName} checked in at ${locationName}`,
                data: {
                    type: "new_checkin",
                    authorId,
                    checkInId,
                },
            });
            totalSent += sent;
        }

        console.log(
            "onCheckinCreated: authorId=%s checkInId=%s followers=%d sent=%d",
            authorId,
            checkInId,
            followerIds.length,
            totalSent,
        );
        return null;
    },
);
