import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
    SPARQL_POI_CATEGORIES,
    WIKIDATA_SPARQL_MAX_ATTEMPTS,
    WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS,
    WIKIDATA_SPARQL_TIMEOUT_MS,
    WikidataSparqlTransientError,
    isWikidataSparqlAbortError,
    runWikidataSparql,
    sparqlTimeoutMsForRadius,
} from "../utils/places-lookup-utils.mjs";
import { buildNearbyPopularPlacesSparql, buildGlobalSearchPopularPlacesSparql } from "../utils/wikidata-nearby-utils.mjs";

const categoryQids = () =>
    new Set([...SPARQL_POI_CATEGORIES.matchAll(/Q\d+/g)].map((match) => match[0]));

describe("SPARQL POI category whitelist", () => {
    it("includes key heritage and sightseeing types", () => {
        const categories = categoryQids();
        expect(categories.has("Q570116")).toBe(true); // tourist attraction
        expect(categories.has("Q483453")).toBe(true); // fountain
        expect(categories.has("Q16560")).toBe(true); // palace
        expect(categories.has("Q907116")).toBe(true); // Monument (Spain)
        expect(categories.has("Q916475")).toBe(true); // Historical Monument (France)
        expect(categories.has("Q2977")).toBe(true); // cathedral
        expect(categories.has("Q56242215")).toBe(true); // Catholic cathedral
        expect(categories.has("Q163687")).toBe(true); // basilica
        expect(categories.has("Q120560")).toBe(true); // minor basilica
        expect(categories.has("Q133747929")).toBe(true); // expiatory temple
        expect(categories.has("Q1864226")).toBe(true); // campanile
        expect(categories.has("Q5003624")).toBe(true); // memorial
        expect(categories.has("Q43501")).toBe(true); // zoo
        expect(categories.has("Q194195")).toBe(true); // amusement park
    });

    it("excludes infrastructure, venues, and wrong QIDs", () => {
        const categories = categoryQids();
        expect(categories.has("Q849706")).toBe(false); // airport terminal
        expect(categories.has("Q54114")).toBe(false); // boulevard
        expect(categories.has("Q41253")).toBe(false); // movie theater
        expect(categories.has("Q3918")).toBe(false); // university
        expect(categories.has("Q811979")).toBe(false); // architectural structure
        expect(categories.has("Q174782")).toBe(false); // square
        expect(categories.has("Q483110")).toBe(false); // stadium
        expect(categories.has("Q39614")).toBe(false); // cemetery
        expect(categories.has("Q24354")).toBe(false); // theatre building
        expect(categories.has("Q12518")).toBe(false); // generic tower
        expect(categories.has("Q12280")).toBe(false); // bridge
        expect(categories.has("Q8502")).toBe(false); // mountain
        expect(categories.has("Q358")).toBe(false); // heritage site (too broad)
        expect(categories.has("Q3615570")).toBe(false); // Campanile snail genus
        expect(categories.has("Q851563")).toBe(false); // Memorial NGO
        expect(categories.has("Q10502151")).toBe(false); // fungus
        expect(categories.has("Q10864048")).toBe(false); // admin division
        expect(categories.has("Q213422")).toBe(false); // Seneca
    });
});

describe("nearby popular SPARQL", () => {
    it("uses the caller-provided radius", () => {
        const query = buildNearbyPopularPlacesSparql(49.4093582, 8.694724, 10);
        expect(query).toContain('bd:serviceParam wikibase:radius "10"');
        expect(query).toContain("ORDER BY DESC(?sitelinks)");
    });
});

describe("global search popular SPARQL", () => {
    it("ranks by sitelinks and excludes non-POI types without a category join", () => {
        const query = buildGlobalSearchPopularPlacesSparql(48.8575475, 2.3513765, 10);
        expect(query).toContain("ORDER BY DESC(?sitelinks)");
        expect(query).toContain("LIMIT 40");
        expect(query).toContain("FILTER NOT EXISTS");
        expect(query).toContain("wdt:P31/wdt:P279* ?excluded");
        expect(query).toContain("wd:Q928830"); // metro station
        expect(query).toContain("wd:Q55488"); // railway station
        expect(query).toContain("wd:Q849706"); // airport terminal
        expect(query).not.toContain("VALUES ?category");
        expect(query).not.toContain("p:P31");
        expect(query).not.toContain("?country wdt:P297");
        expect(query).not.toContain("?itemDescription");
    });

    it("uses a lower sitelinks floor for POI anchors at 3 km", () => {
        const query = buildGlobalSearchPopularPlacesSparql(48.8606111, 2.337644, 3);
        expect(query).toContain('bd:serviceParam wikibase:radius "3"');
        expect(query).toContain("FILTER(?sitelinks >= 10)");
    });
});

describe("sparqlTimeoutMsForRadius", () => {
    it("uses the longer timeout for global search radii", () => {
        expect(sparqlTimeoutMsForRadius(10)).toBe(WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS);
    });

    it("uses the default timeout for near-me radii", () => {
        expect(sparqlTimeoutMsForRadius(3)).toBe(WIKIDATA_SPARQL_TIMEOUT_MS);
    });
});

describe("isWikidataSparqlAbortError", () => {
    it("detects AbortError and aborted messages", () => {
        expect(isWikidataSparqlAbortError({ name: "AbortError" })).toBe(true);
        expect(isWikidataSparqlAbortError(new Error("This operation was aborted"))).toBe(true);
        expect(isWikidataSparqlAbortError(new Error("network failure"))).toBe(false);
    });
});

describe("runWikidataSparql", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("retries once after an abort and succeeds", async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ results: { bindings: [{ item: { value: "x" } }] } }),
            });

        const promise = runWikidataSparql("SELECT ?item WHERE { ?item ?p ?o }", fetchImpl, {
            extra: "test-query",
            maxAttempts: WIKIDATA_SPARQL_MAX_ATTEMPTS,
        });
        await vi.runAllTimersAsync();
        const bindings = await promise;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(bindings).toHaveLength(1);
    });

    it("throws WikidataSparqlTransientError with 504 after retries are exhausted", async () => {
        const fetchImpl = vi.fn().mockRejectedValue(
            Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
        );

        const promise = runWikidataSparql("SELECT ?item WHERE { ?item ?p ?o }", fetchImpl, {
            extra: "barcelona radiusKm=10",
            maxAttempts: 2,
        });
        const expectation = expect(promise).rejects.toBeInstanceOf(WikidataSparqlTransientError);
        await vi.runAllTimersAsync();
        await expectation;

        try {
            await promise;
        } catch (error) {
            expect(error.statusCode).toBe(504);
            expect(error.extra).toBe("barcelona radiusKm=10");
            expect(error.attempts).toBe(2);
        }
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
