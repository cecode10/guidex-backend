/**
 * Blocked-user helpers shared by Cloud Functions and notification gating.
 * Blocked IDs live on the blocker’s user profile as `blockedUserIds`.
 */

/**
 * @param {Record<string, unknown> | undefined | null} userData
 * @returns {string[]}
 */
export const blockedUserIdsFromUserDoc = (userData) => {
    if (!userData) return [];
    const raw = userData.blockedUserIds;
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => typeof id === "string" && id.length > 0);
};

/**
 * True when either profile has the other on their blacklist.
 *
 * @param {Record<string, unknown> | undefined | null} aData
 * @param {string} bId
 * @param {Record<string, unknown> | undefined | null} bData
 * @param {string} aId
 * @returns {boolean}
 */
export const isBlockedEitherWay = (aData, bId, bData, aId) => {
    if (!aId || !bId || aId === bId) return false;
    return blockedUserIdsFromUserDoc(aData).includes(bId)
        || blockedUserIdsFromUserDoc(bData).includes(aId);
};

/**
 * UIDs newly added to `blockedUserIds` on a profile update.
 *
 * @param {Record<string, unknown> | undefined | null} beforeData
 * @param {Record<string, unknown> | undefined | null} afterData
 * @returns {string[]}
 */
export const newlyBlockedUserIds = (beforeData, afterData) => {
    const before = new Set(blockedUserIdsFromUserDoc(beforeData));
    return blockedUserIdsFromUserDoc(afterData).filter((id) => !before.has(id));
};
