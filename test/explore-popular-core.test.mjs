import { describe, expect, it } from "vitest";
import {
    explorePopularHttpStatus,
    exploreSearchTargetFromGeocode,
    forwardGeocodeHasLocalityMetadata,
} from "../services/explore-popular-core.mjs";
import { WikidataSparqlTransientError } from "../utils/places-lookup-utils.mjs";

describe("exploreSearchTargetFromGeocode", () => {
    it("returns the point and Google's viewport", () => {
        expect(
            exploreSearchTargetFromGeocode({
                geometry: {
                    location: { lat: 41.9028, lng: 12.4964 },
                    viewport: {
                        northeast: { lat: 42.05, lng: 12.73 },
                        southwest: { lat: 41.76, lng: 12.34 },
                    },
                },
            }),
        ).toEqual({
            lat: 41.9028,
            lng: 12.4964,
            viewport: { south: 41.76, west: 12.34, north: 42.05, east: 12.73 },
        });
    });

    it("keeps antimeridian viewports as west > east", () => {
        const target = exploreSearchTargetFromGeocode({
            geometry: {
                location: { lat: -17.7, lng: 178.1 },
                viewport: {
                    northeast: { lat: -12.4, lng: -178.2 },
                    southwest: { lat: -21.1, lng: 176.8 },
                },
            },
        });
        expect(target.viewport.west).toBeGreaterThan(target.viewport.east);
    });

    it("drops a missing viewport and rejects results without a point", () => {
        expect(
            exploreSearchTargetFromGeocode({ geometry: { location: { lat: 1, lng: 2 } } }),
        ).toEqual({ lat: 1, lng: 2, viewport: null });
        expect(exploreSearchTargetFromGeocode({ geometry: {} })).toBeNull();
    });
});

describe("forwardGeocodeHasLocalityMetadata", () => {
    it("returns true when forward geocode has city and country", () => {
        const geocodeResult = {
            formatted_address: "Barcelona, Spain",
            address_components: [
                { long_name: "Barcelona", types: ["locality", "political"] },
                { short_name: "ES", types: ["country", "political"] },
            ],
            geometry: { location: { lat: 41.3851, lng: 2.1734 } },
        };
        expect(forwardGeocodeHasLocalityMetadata(geocodeResult, 41.3851, 2.1734)).toBe(true);
    });

    it("returns false when country is missing", () => {
        const geocodeResult = {
            formatted_address: "Barcelona",
            address_components: [
                { long_name: "Barcelona", types: ["locality", "political"] },
            ],
            geometry: { location: { lat: 41.3851, lng: 2.1734 } },
        };
        expect(forwardGeocodeHasLocalityMetadata(geocodeResult, 41.3851, 2.1734)).toBe(false);
    });
});

describe("explorePopularHttpStatus", () => {
    it("maps WikidataSparqlTransientError to 504", () => {
        const error = new WikidataSparqlTransientError("timed out");
        expect(explorePopularHttpStatus(error)).toBe(504);
    });

    it("preserves explicit statusCode on errors", () => {
        expect(explorePopularHttpStatus({ statusCode: 401 })).toBe(401);
    });

    it("defaults unknown errors to 500", () => {
        expect(explorePopularHttpStatus(new Error("boom"))).toBe(500);
    });
});
