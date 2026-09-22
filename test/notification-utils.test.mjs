import { describe, expect, it } from "vitest";
import {
    ALWAYS,
    CHECKIN_LIKES_SETTING,
    NEVER,
    NEW_CHECKINS_SETTING,
    NEW_FOLLOWERS_SETTING,
    PEOPLE_I_FOLLOW,
    displayNameFromUserDoc,
    extractNotificationSetting,
    matchesBinaryPolicy,
    matchesThreeWayPolicy,
    releaseFcmTokenFromOtherUsers,
    tokenDocumentId,
} from "../utils/notification-utils.mjs";

describe("notification-utils", () => {
    it("extractNotificationSetting prefers nested settings", () => {
        expect(
            extractNotificationSetting(
                { settings: { [CHECKIN_LIKES_SETTING]: NEVER } },
                CHECKIN_LIKES_SETTING,
                ALWAYS,
            ),
        ).toBe(NEVER);
        expect(
            extractNotificationSetting(
                { [NEW_CHECKINS_SETTING]: NEVER },
                NEW_CHECKINS_SETTING,
                ALWAYS,
            ),
        ).toBe(NEVER);
        expect(
            extractNotificationSetting(undefined, NEW_FOLLOWERS_SETTING, ALWAYS),
        ).toBe(ALWAYS);
    });

    it("matchesThreeWayPolicy respects never, people_i_follow, and always", () => {
        expect(matchesThreeWayPolicy(NEVER, true)).toBe(false);
        expect(matchesThreeWayPolicy(PEOPLE_I_FOLLOW, false)).toBe(false);
        expect(matchesThreeWayPolicy(PEOPLE_I_FOLLOW, true)).toBe(true);
        expect(matchesThreeWayPolicy(ALWAYS, false)).toBe(true);
    });

    it("matchesBinaryPolicy only blocks never", () => {
        expect(matchesBinaryPolicy(NEVER)).toBe(false);
        expect(matchesBinaryPolicy(ALWAYS)).toBe(true);
    });

    it("displayNameFromUserDoc resolves username then displayName", () => {
        expect(displayNameFromUserDoc({ username: "alice" }, "uid")).toBe("alice");
        expect(displayNameFromUserDoc({ displayName: "Alice B" }, "uid")).toBe("Alice B");
        expect(displayNameFromUserDoc({}, "uid123")).toBe("uid123");
    });

    it("tokenDocumentId is stable and truncated", () => {
        const id = tokenDocumentId("abc123");
        expect(id).toHaveLength(32);
        expect(id).toBe(tokenDocumentId("abc123"));
    });

    it("releaseFcmTokenFromOtherUsers deletes the token from every other account", async () => {
        const db = createFakeTokenDb([
            { uid: "account-a", token: "device-token" },
            { uid: "account-c", token: "device-token" },
            { uid: "account-a", token: "other-device" },
        ]);

        const removed = await releaseFcmTokenFromOtherUsers(db, "device-token", "account-c");

        expect(removed).toBe(1);
        expect(db.paths()).toEqual([
            "users/account-a/fcmTokens/other-device",
            "users/account-c/fcmTokens/device-token",
        ]);
    });

    it("releaseFcmTokenFromOtherUsers ignores empty input", async () => {
        const db = createFakeTokenDb([
            { uid: "account-a", token: "device-token" },
        ]);

        expect(await releaseFcmTokenFromOtherUsers(db, "", "account-c")).toBe(0);
        expect(await releaseFcmTokenFromOtherUsers(db, "device-token", "")).toBe(0);
        expect(db.paths()).toEqual(["users/account-a/fcmTokens/device-token"]);
    });
});

/**
 * @param {Array<{ uid: string, token: string }>} entries
 */
function createFakeTokenDb(entries) {
    const store = new Map(
        entries.map((entry) => [
            `users/${entry.uid}/fcmTokens/${entry.token}`,
            { token: entry.token },
        ]),
    );

    const docFromPath = (path) => {
        const uid = path.split("/")[1];
        return {
            data: () => store.get(path),
            ref: {
                path,
                parent: { parent: { id: uid } },
            },
        };
    };

    return {
        paths: () => [...store.keys()].sort(),
        collectionGroup() {
            return {
                where(field, _op, value) {
                    return {
                        async get() {
                            const docs = [];
                            for (const [path, data] of store) {
                                if (data[field] === value) docs.push(docFromPath(path));
                            }
                            return { docs };
                        },
                    };
                },
            };
        },
        batch() {
            /** @type {string[]} */
            const deletes = [];
            return {
                delete(ref) {
                    deletes.push(ref.path);
                },
                async commit() {
                    for (const path of deletes) store.delete(path);
                },
            };
        },
    };
}
