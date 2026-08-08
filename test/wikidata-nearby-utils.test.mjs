import { describe, expect, it } from "vitest";
import {
    SPARQL_PROFILE,
    SPARQL_METRO_FETCH_LIMIT,
    SPARQL_QUALITY_FETCH_LIMIT,
    buildPopularPlacesSparqlForProfile,
    isValidSparqlProfile,
    normalizeSparqlProfile,
    resolveSparqlFetchOptions,
    sparqlProfileMatchesCache,
} from "../utils/wikidata-nearby-utils.mjs";

describe("sparql profile helpers", () => {
    it("validates known profiles", () => {
        expect(isValidSparqlProfile("quality")).toBe(true);
        expect(isValidSparqlProfile("fast")).toBe(true);
        expect(isValidSparqlProfile("slow")).toBe(false);
    });

    it("defaults unknown profiles to fast", () => {
        expect(normalizeSparqlProfile("unknown")).toBe(SPARQL_PROFILE.FAST);
    });

    it("treats legacy cache entries as fast profile", () => {
        expect(sparqlProfileMatchesCache(null, SPARQL_PROFILE.FAST)).toBe(true);
        expect(sparqlProfileMatchesCache(null, SPARQL_PROFILE.QUALITY)).toBe(false);
        expect(sparqlProfileMatchesCache("quality", SPARQL_PROFILE.QUALITY)).toBe(true);
    });
});

describe("buildPopularPlacesSparqlForProfile", () => {
    it("uses category whitelist for quality profile", () => {
        const query = buildPopularPlacesSparqlForProfile(
            49.399,
            8.672,
            10,
            SPARQL_PROFILE.QUALITY,
            SPARQL_METRO_FETCH_LIMIT,
        );
        expect(query).toContain("VALUES ?category");
        expect(query).toContain(`LIMIT ${SPARQL_METRO_FETCH_LIMIT}`);
        expect(query).not.toContain("FILTER(?sitelinks >=");
    });

    it("uses fast explore query for fast profile", () => {
        const query = buildPopularPlacesSparqlForProfile(49.399, 8.672, 10, SPARQL_PROFILE.FAST);
        expect(query).toContain("FILTER(?sitelinks >=");
        expect(query).not.toContain("VALUES ?category");
    });
});

describe("resolveSparqlFetchOptions", () => {
    it("uses longer timeout and more retries for quality profile", () => {
        const quality = resolveSparqlFetchOptions({ sparqlProfile: SPARQL_PROFILE.QUALITY });
        const fast = resolveSparqlFetchOptions({
            sparqlProfile: SPARQL_PROFILE.FAST,
            globalSearch: true,
        });
        expect(quality.timeoutMs).toBeGreaterThan(fast.timeoutMs);
        expect(quality.maxAttempts).toBeGreaterThan(fast.maxAttempts);
    });
});
