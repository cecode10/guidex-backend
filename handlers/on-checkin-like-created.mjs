import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import {
    ALWAYS,
    CHECKIN_LIKES_SETTING,
    displayNameFromUserDoc,
    extractNotificationSetting,
    matchesThreeWayPolicy,
    sendPushToUser,
    userFollows,
} from "../notification-utils.mjs";

/**
 * Notifies a check-in author when someone likes their check-in.
 */
export const onCheckinLikeCreated = onDocumentCreated(
    {
        document: "users/{authorId}/checkins/{checkInId}/likes/{likerId}",
        region: "europe-west3",
    },
    async (event) => {
        const { authorId, checkInId, likerId } = event.params;
        if (authorId === likerId) return null;

        const db = getFirestore();
        const messaging = getMessaging();

        const authorDoc = await db.collection("users").doc(authorId).get();
        const authorData = authorDoc.data();
        const setting = extractNotificationSetting(
            authorData,
            CHECKIN_LIKES_SETTING,
            ALWAYS,
        );

        const authorFollowsLiker = setting === "people_i_follow"
            ? await userFollows(db, authorId, likerId)
            : false;

        if (!matchesThreeWayPolicy(setting, authorFollowsLiker)) {
            return null;
        }

        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = displayNameFromUserDoc(likerDoc.data(), likerId);

        const checkInDoc = await db
            .collection("users")
            .doc(authorId)
            .collection("checkins")
            .doc(checkInId)
            .get();
        const checkInData = checkInDoc.data();
        const locationName = typeof checkInData?.locationName === "string"
            ? checkInData.locationName
            : "your check-in";

        const sent = await sendPushToUser(db, messaging, authorId, {
            title: "New like",
            body: `${likerName} liked your check-in at ${locationName}`,
            data: {
                type: "checkin_like",
                authorId,
                checkInId,
                likerId,
            },
        });

        console.log(
            "onCheckinLikeCreated: authorId=%s checkInId=%s likerId=%s sent=%d",
            authorId,
            checkInId,
            likerId,
            sent,
        );
        return null;
    },
);
