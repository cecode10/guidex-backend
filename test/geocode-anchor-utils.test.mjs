import { describe, expect, it } from "vitest";
import { popularSearchRadiusKmFromGeocodeTypes } from "../utils/geocode-anchor-utils.mjs";

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
});
