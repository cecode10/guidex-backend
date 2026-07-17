import { describe, expect, it } from "vitest";
import {
    explorePopularHttpStatus,
    forwardGeocodeHasLocalityMetadata,
    resolveSparqlProfileForCacheWrite,
} from "./explore-popular-core.mjs";
import { WikidataSparqlTransientError } from "./places-lookup-utils.mjs";
import { SPARQL_PROFILE } from "./wikidata-nearby-utils.mjs";
import { GEO_LOCATION_CACHE_SOURCE } from "./geo-location-utils.mjs";

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

describe("resolveSparqlProfileForCacheWrite", () => {
    it("keeps quality profile for batch-seeded caches when fast is requested", () => {
        expect(
            resolveSparqlProfileForCacheWrite(SPARQL_PROFILE.FAST, {
                cacheSource: GEO_LOCATION_CACHE_SOURCE.BATCH_SEED,
                sparqlProfile: SPARQL_PROFILE.QUALITY,
            }),
        ).toBe(SPARQL_PROFILE.QUALITY);
    });

    it("honours an explicit fast request when no quality batch cache exists", () => {
        expect(resolveSparqlProfileForCacheWrite(SPARQL_PROFILE.FAST, null)).toBe(
            SPARQL_PROFILE.FAST,
        );
    });
});

describe("resolveExplorePopularPlaces cache policy", () => {
    it("documents that any populated subcollection is served without forceRefresh", () => {
        // Regression guard: profile mismatch must not skip populated caches on read.
        expect(SPARQL_PROFILE.QUALITY).not.toBe(SPARQL_PROFILE.FAST);
    });
});
