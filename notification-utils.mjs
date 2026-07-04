import { createHash } from "node:crypto";

export const NEVER = "never";
export const PEOPLE_I_FOLLOW = "people_i_follow";
export const ALWAYS = "always";

export const CHECKIN_LIKES_SETTING = "notificationsCheckInLikes";
export const NEW_CHECKINS_SETTING = "notificationsNewCheckins";
export const NEW_FOLLOWERS_SETTING = "notificationsNewFollowers";

export const ANDROID_SOCIAL_CHANNEL_ID = "com.kudosai.ramblex.channel.social";
export const ANDROID_NOTIFICATION_ICON = "ic_notification";
export const ANDROID_NOTIFICATION_COLOR = "#201E28";

/**
 * @param {Record<string, unknown> | undefined} userData
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
export const extractNotificationSetting = (userData, key, defaultValue) => {
    if (!userData) return defaultValue;
    const settings = userData.settings;
    if (settings && typeof settings === "object" && key in settings) {
        const fromSettings = settings[key];
        if (typeof fromSettings === "string") return fromSettings;
    }
    const topLevel = userData[key];
    if (typeof topLevel === "string") return topLevel;
    return defaultValue;
};

/**
 * @param {string} setting
 * @param {boolean} relatedProfileFollowed
 * @returns {boolean}
 */
export const matchesThreeWayPolicy = (setting, relatedProfileFollowed) => {
    if (setting === NEVER) return false;
    if (setting === PEOPLE_I_FOLLOW) return relatedProfileFollowed;
    return true;
};

/**
 * @param {string} setting
 * @returns {boolean}
 */
export const matchesBinaryPolicy = (setting) => setting !== NEVER;

/**
 * @param {Record<string, unknown> | undefined} userData
 * @param {string} fallbackUid
 * @returns {string}
 */
export const displayNameFromUserDoc = (userData, fallbackUid) => {
    if (!userData) return fallbackUid;
    const username = userData.username;
    const displayName = userData.displayName;
    if (typeof username === "string" && username.length > 0) return username;
    if (typeof displayName === "string" && displayName.length > 0) return displayName;
    return fallbackUid;
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} followerUid
 * @param {string} targetUid
 * @returns {Promise<boolean>}
 */
export const userFollows = async (db, followerUid, targetUid) => {
    const doc = await db
        .collection("users")
        .doc(followerUid)
        .collection("friends")
        .doc(targetUid)
        .get();
    return doc.exists;
};

/**
 * Returns UIDs of users who follow [targetUid].
 *
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} targetUid
 * @returns {Promise<string[]>}
 */
export const followerIdsOf = async (db, targetUid) => {
    const snapshot = await db
        .collectionGroup("friends")
        .where("friendId", "==", targetUid)
        .get();
    return snapshot.docs
        .map((doc) => doc.ref.parent.parent?.id)
        .filter((uid) => typeof uid === "string");
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} uid
 * @returns {Promise<Array<{ id: string, token: string }>>}
 */
export const loadFcmTokens = async (db, uid) => {
    const snapshot = await db.collection("users").doc(uid).collection("fcmTokens").get();
    return snapshot.docs
        .map((doc) => ({ id: doc.id, token: doc.data().token }))
        .filter((entry) => typeof entry.token === "string" && entry.token.length > 0);
};

const FCM_BATCH_SIZE = 500;

/**
 * @param {import("firebase-admin/messaging").Messaging} messaging
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data: Record<string, string> }} payload
 * @returns {Promise<import("firebase-admin/messaging").BatchResponse>}
 */
export const sendMulticast = async (messaging, tokens, payload) => {
    if (tokens.length === 0) {
        return { successCount: 0, failureCount: 0, responses: [] };
    }

    if (tokens.length <= FCM_BATCH_SIZE) {
        return messaging.sendEachForMulticast({
            tokens,
            notification: {
                title: payload.title,
                body: payload.body,
            },
            data: payload.data,
            android: {
                notification: {
                    channelId: ANDROID_SOCIAL_CHANNEL_ID,
                    icon: ANDROID_NOTIFICATION_ICON,
                    color: ANDROID_NOTIFICATION_COLOR,
                },
            },
            apns: {
                payload: {
                    aps: {
                        sound: "default",
                    },
                },
            },
        });
    }

    let successCount = 0;
    let failureCount = 0;
    const responses = [];

    for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
        const chunk = tokens.slice(i, i + FCM_BATCH_SIZE);
        const batchResult = await messaging.sendEachForMulticast({
            tokens: chunk,
            notification: {
                title: payload.title,
                body: payload.body,
            },
            data: payload.data,
            android: {
                notification: {
                    channelId: ANDROID_SOCIAL_CHANNEL_ID,
                    icon: ANDROID_NOTIFICATION_ICON,
                    color: ANDROID_NOTIFICATION_COLOR,
                },
            },
            apns: {
                payload: {
                    aps: {
                        sound: "default",
                    },
                },
            },
        });
        successCount += batchResult.successCount;
        failureCount += batchResult.failureCount;
        responses.push(...batchResult.responses);
    }

    return { successCount, failureCount, responses };
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} uid
 * @param {Array<{ id: string, token: string }>} tokenEntries
 * @param {import("firebase-admin/messaging").BatchResponse["responses"]} responses
 */
export const pruneInvalidTokens = async (db, uid, tokenEntries, responses) => {
    const batch = db.batch();
    let pendingDeletes = 0;

    for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        if (!response.success) {
            const code = response.error?.code;
            if (
                code === "messaging/registration-token-not-registered"
                || code === "messaging/invalid-registration-token"
            ) {
                batch.delete(
                    db.collection("users").doc(uid).collection("fcmTokens").doc(tokenEntries[i].id),
                );
                pendingDeletes++;
            }
        }
    }

    if (pendingDeletes > 0) {
        await batch.commit();
    }
};

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {import("firebase-admin/messaging").Messaging} messaging
 * @param {string} recipientUid
 * @param {{ title: string, body: string, data: Record<string, string> }} payload
 * @returns {Promise<number>}
 */
export const sendPushToUser = async (db, messaging, recipientUid, payload) => {
    const tokenEntries = await loadFcmTokens(db, recipientUid);
    if (tokenEntries.length === 0) return 0;

    const tokens = tokenEntries.map((entry) => entry.token);
    const result = await sendMulticast(messaging, tokens, payload);
    await pruneInvalidTokens(db, recipientUid, tokenEntries, result.responses);
    return result.successCount;
};

/**
 * @param {string} token
 * @returns {string}
 */
export const tokenDocumentId = (token) =>
    createHash("sha256").update(token).digest("hex").slice(0, 32);
