import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import {
    ALWAYS,
    NEW_FOLLOWERS_SETTING,
    displayNameFromUserDoc,
    extractNotificationSetting,
    matchesThreeWayPolicy,
    sendPushToUser,
    userFollows,
} from "../notification-utils.mjs";

/**
 * Notifies a user when someone starts following them.
 */
export const onFollowerAdded = onDocumentCreated(
    {
        document: "users/{followerId}/friends/{targetId}",
        region: "europe-west3",
    },
    async (event) => {
        const { followerId, targetId } = event.params;
        if (followerId === targetId) return null;

        const db = getFirestore();
        const messaging = getMessaging();

        const targetDoc = await db.collection("users").doc(targetId).get();
        const targetData = targetDoc.data();
        const setting = extractNotificationSetting(
            targetData,
            NEW_FOLLOWERS_SETTING,
            ALWAYS,
        );

        const targetFollowsFollower = setting === "people_i_follow"
            ? await userFollows(db, targetId, followerId)
            : false;

        if (!matchesThreeWayPolicy(setting, targetFollowsFollower)) {
            return null;
        }

        const followerDoc = await db.collection("users").doc(followerId).get();
        const followerName = displayNameFromUserDoc(followerDoc.data(), followerId);

        const sent = await sendPushToUser(db, messaging, targetId, {
            title: "New follower",
            body: `${followerName} started following you`,
            data: {
                type: "new_follower",
                followerId,
                targetId,
            },
        });

        console.log(
            "onFollowerAdded: followerId=%s targetId=%s sent=%d",
            followerId,
            targetId,
            sent,
        );
        return null;
    },
);
