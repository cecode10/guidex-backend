import { describe, expect, it } from "vitest";
import {
    POPULAR_SEARCH_RADIUS_FALLBACK_KM,
    isValidPopularSearchRadiusKm,
    normalizePopularSearchRadiusKm,
    popularSearchRadiusKmFromGeocodeTypes,
} from "./geocode-anchor-utils.mjs";

describe("popular search radius policy", () => {
    it("uses 10 km for locality-type geocode results", () => {
        expect(
            popularSearchRadiusKmFromGeocodeTypes(["locality", "political"]),
        ).toBe(10);
    });

    it("never goes below the nearby minimum for POI-type geocode results", () => {
        expect(
            popularSearchRadiusKmFromGeocodeTypes(["tourist_attraction"]),
        ).toBe(3);
    });

    it("validates client-provided radii", () => {
        expect(isValidPopularSearchRadiusKm(10)).toBe(true);
        expect(isValidPopularSearchRadiusKm(0)).toBe(false);
        expect(isValidPopularSearchRadiusKm(999)).toBe(false);
        expect(isValidPopularSearchRadiusKm("10")).toBe(true);
    });

    it("normalizes client-provided radii to the supported range", () => {
        expect(normalizePopularSearchRadiusKm(2)).toBe(3);
        expect(normalizePopularSearchRadiusKm(10)).toBe(10);
        expect(normalizePopularSearchRadiusKm("bad")).toBe(
            POPULAR_SEARCH_RADIUS_FALLBACK_KM,
        );
    });
});
