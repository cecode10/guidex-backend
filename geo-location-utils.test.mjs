import { describe, expect, it } from "vitest";
import {
    geoLocationKeyFromCoords,
    geoLocationSearchKeyFromCoords,
} from "./geo-location-utils.mjs";

describe("geo-location cache keys", () => {
    it("keeps normal nearby cache keys coordinate-only", () => {
        expect(geoLocationKeyFromCoords(49.4093582, 8.694724)).toBe("49.4094_8.6947");
    });

    it("scopes Explore search cache keys by coords and radius only", () => {
        expect(
            geoLocationSearchKeyFromCoords(49.4093582, 8.694724, {
                radiusKm: 10,
            }),
        ).toBe("49.4094_8.6947__search_r10");
    });

    it("shares search cache keys for the same coords and radius", () => {
        expect(
            geoLocationSearchKeyFromCoords(41.3874, 2.1686, { radiusKm: 10 }),
        ).toBe("41.3874_2.1686__search_r10");
        expect(
            geoLocationSearchKeyFromCoords(41.3874, 2.1686, { radiusKm: 3 }),
        ).toBe("41.3874_2.1686__search_r3");
    });

    it("does not fall back to the near-me coordinate key", () => {
        expect(geoLocationSearchKeyFromCoords(49.4093582, 8.694724, { radiusKm: 0 })).toBe("");
    });
});
