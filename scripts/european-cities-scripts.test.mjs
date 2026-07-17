import { describe, expect, it } from "vitest";
import {
    buildEuropeanCitiesSparql,
    dedupeEuropeanCities,
    filterSeedableCityRows,
    isLikelyAdminDivisionLabel,
    normalizeCityLabel,
    wikidataIdFromUri,
} from "./generate-european-cities-list.mjs";
import { EUROPEAN_COUNTRIES } from "./european-cities-config.mjs";
import { citySearchQuery, summarizeSeedReport } from "./seed-european-city-search-cache.mjs";

describe("buildEuropeanCitiesSparql", () => {
    it("includes population filter and country id", () => {
        const query = buildEuropeanCitiesSparql("Q183", 100_000);
        expect(query).toContain("wd:Q183");
        expect(query).toContain("?population >= 100000");
    });

    it("requires settlement types and excludes admin divisions", () => {
        const query = buildEuropeanCitiesSparql("Q183", 100_000);
        expect(query).toContain("wd:Q515");
        expect(query).toContain("wd:Q200250");
        expect(query).toContain("wd:Q2074737");
        expect(query).toContain("wd:Q6256");
        expect(query).toContain("?population < 20000000");
    });
});

describe("mergeEuropeanCityRows", () => {
    it("keeps existing rows and adds only new wikidata ids", async () => {
        const { mergeEuropeanCityRows } = await import("./generate-european-cities-list.mjs");
        const merged = mergeEuropeanCityRows(
            [
                {
                    name: "Paris",
                    country: "France",
                    searchQuery: "Paris, France",
                    wikidataId: "Q90",
                    lat: 1,
                    lon: 2,
                    population: 2_000_000,
                },
            ],
            [
                {
                    name: "Paris",
                    country: "France",
                    searchQuery: "Paris, France",
                    wikidataId: "Q90",
                    lat: 9,
                    lon: 9,
                    population: 9_000_000,
                },
                {
                    name: "Sofia",
                    country: "Bulgaria",
                    searchQuery: "Sofia, Bulgaria",
                    wikidataId: "Q472",
                    lat: 3,
                    lon: 4,
                    population: 1_200_000,
                },
            ],
        );
        expect(merged.added).toBe(1);
        expect(merged.skipped).toBe(1);
        expect(merged.cities).toHaveLength(2);
        expect(merged.cities.find((city) => city.wikidataId === "Q90")?.lat).toBe(1);
    });
});

describe("filterSeedableCityRows", () => {
    it("drops admin division labels", () => {
        const rows = filterSeedableCityRows([
            {
                name: "Tirana County",
                country: "Albania",
                searchQuery: "Tirana County, Albania",
                wikidataId: "Q1",
                lat: 1,
                lon: 2,
                population: 200_000,
            },
            {
                name: "Tirana",
                country: "Albania",
                searchQuery: "Tirana, Albania",
                wikidataId: "Q2",
                lat: 1,
                lon: 2,
                population: 400_000,
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe("Tirana");
    });
});

describe("isLikelyAdminDivisionLabel", () => {
    it("flags county labels", () => {
        expect(isLikelyAdminDivisionLabel("Berat County")).toBe(true);
    });
});

describe("normalizeCityLabel", () => {
    it("strips parenthetical disambiguators", () => {
        expect(normalizeCityLabel("Frankfurt (Oder)")).toBe("Frankfurt");
    });
});

describe("wikidataIdFromUri", () => {
    it("extracts QID from entity URI", () => {
        expect(wikidataIdFromUri("http://www.wikidata.org/entity/Q64")).toBe("Q64");
    });
});

describe("dedupeEuropeanCities", () => {
    it("keeps highest population per wikidata id", () => {
        const payload = dedupeEuropeanCities(EUROPEAN_COUNTRIES.slice(0, 1), [
            {
                name: "Alpha",
                country: "Albania",
                searchQuery: "Alpha, Albania",
                wikidataId: "Q1",
                lat: 1,
                lon: 2,
                population: 100_000,
            },
            {
                name: "Alpha",
                country: "Albania",
                searchQuery: "Alpha, Albania",
                wikidataId: "Q1",
                lat: 1,
                lon: 2,
                population: 150_000,
            },
        ]);
        expect(payload.count).toBe(1);
        expect(payload.cities[0].population).toBe(150_000);
    });
});

describe("citySearchQuery", () => {
    it("prefers explicit searchQuery", () => {
        expect(citySearchQuery({ name: "Paris", country: "France", searchQuery: "Paris, FR" })).toBe(
            "Paris, FR",
        );
    });

    it("builds query from name and country", () => {
        expect(citySearchQuery({ name: "Berlin", country: "Germany" })).toBe("Berlin, Germany");
    });
});

describe("summarizeSeedReport", () => {
    it("counts statuses", () => {
        const summary = summarizeSeedReport([
            { index: 0, name: "A", country: "X", searchQuery: "A, X", status: "seeded" },
            { index: 1, name: "B", country: "X", searchQuery: "B, X", status: "sparql_failed" },
        ]);
        expect(summary.seeded).toBe(1);
        expect(summary.sparql_failed).toBe(1);
    });
});
