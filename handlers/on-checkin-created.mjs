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
    userFollows,
} from "../utils/notification-utils.mjs";

const EVERYONE = "everyone";
const PEOPLE_I_FOLLOW = "people_i_follow";
const NO_ONE = "no_one";
const CHECK_INS_VISIBILITY_KEY = "whoCanSeeMyCheckIns";

/**
 * @param {Record<string, unknown> | undefined} userData
 * @returns {string}
 */
const checkInsVisibilityFromUserDoc = (userData) => {
    const raw = (() => {
        if (!userData) return EVERYONE;
        const settings = userData.settings;
        if (settings && typeof settings === "object" && CHECK_INS_VISIBILITY_KEY in settings) {
            const fromSettings = settings[CHECK_INS_VISIBILITY_KEY];
            if (typeof fromSettings === "string") return fromSettings;
        }
        const topLevel = userData[CHECK_INS_VISIBILITY_KEY];
        if (typeof topLevel === "string") return topLevel;
        return EVERYONE;
    })();
    if (raw === PEOPLE_I_FOLLOW || raw === NO_ONE) return raw;
    return EVERYONE;
};

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
        const authorData = authorDoc.data();
        const visibility = checkInsVisibilityFromUserDoc(authorData);
        if (visibility === NO_ONE) {
            console.log(
                "onCheckinCreated: authorId=%s checkInId=%s skipped (check-ins private)",
                authorId,
                checkInId,
            );
            return null;
        }

        const authorName = displayNameFromUserDoc(authorData, authorId);
        const locationName = typeof checkInData.locationName === "string"
            ? checkInData.locationName
            : "a new place";

        const followerIds = await followerIdsOf(db, authorId);
        if (followerIds.length === 0) return null;

        let totalSent = 0;

        for (const followerId of followerIds) {
            if (followerId === authorId) continue;

            if (visibility === PEOPLE_I_FOLLOW) {
                const authorFollowsViewer = await userFollows(db, authorId, followerId);
                if (!authorFollowsViewer) continue;
            }

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
