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
    tokenDocumentId,
} from "./notification-utils.mjs";

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
});
