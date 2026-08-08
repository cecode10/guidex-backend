import { describe, expect, it } from "vitest";
import {
    explorePopularHttpStatus,
    forwardGeocodeHasLocalityMetadata,
} from "../services/explore-popular-core.mjs";
import { WikidataSparqlTransientError } from "../utils/places-lookup-utils.mjs";

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
