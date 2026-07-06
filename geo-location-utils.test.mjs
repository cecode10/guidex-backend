import { describe, expect, it } from "vitest";
import {
    geoLocationKeyFromCoords,
    geoLocationSearchKeyFromCoords,
} from "./geo-location-utils.mjs";

describe("geo-location cache keys", () => {
    it("keeps normal nearby cache keys coordinate-only", () => {
        expect(geoLocationKeyFromCoords(49.4093582, 8.694724)).toBe("49.4094_8.6947");
    });

    it("scopes Explore search cache keys by query and radius", () => {
        expect(
            geoLocationSearchKeyFromCoords(49.4093582, 8.694724, {
                searchQuery: "Heidelberg",
                radiusKm: 10,
            }),
        ).toBe("49.4094_8.6947__search_heidelberg_r10");
    });

    it("uses geocode anchor normalization for multi-word search queries", () => {
        expect(
            geoLocationSearchKeyFromCoords(49.4093582, 8.694724, {
                searchQuery: "New York",
                radiusKm: 10,
            }),
        ).toBe("49.4094_8.6947__search_new york_r10");
    });
});
