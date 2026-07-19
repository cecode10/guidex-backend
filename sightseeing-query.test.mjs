import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
    bindingToSightseeingRow,
    buildCountrySightseeingSparql,
    COUNTRY_SIGHTSEEING_BOUNDS,
    countrySightseeingBounds,
    shouldForceTileSeed,
} from "./scripts/seed-europe-sightseeing.mjs";
import { mapSightseeingRowToPlace } from "./sightseeing-query.mjs";
import {
    resetSightseeingPoolForTests,
    resolveSightseeingDatabaseUrl,
} from "./sightseeing-db.mjs";

describe("mapSightseeingRowToPlace", () => {
    it("maps a PostGIS row into the NearLocation-compatible place shape", () => {
        const place = mapSightseeingRowToPlace(
            {
                wikidata_id: "Q243",
                name: "Eiffel Tower",
                type: "LANDMARK",
                country_code: "fr",
                country: "France",
                city: "Paris",
                sitelinks: 200,
                image_url: "http://commons.wikimedia.org/wiki/Special:FilePath/Tour_Eiffel.jpg",
                wikipedia_url: null,
                lat: 48.8584,
                lng: 2.2945,
                distance_m: 120.4,
            },
            { city: "Paris", order: 0 },
        );

        expect(place).toMatchObject({
            name: "Eiffel Tower",
            type: "LANDMARK",
            distance: 120,
            city: "Paris",
            country: "France",
            countryCode: "FR",
            wikidataId: "Q243",
            lat: 48.8584,
            lng: 2.2945,
            sitelinks: 200,
            order: 0,
        });
        expect(place.countryFlag).toBeTruthy();
        expect(place.image).toContain("Tour_Eiffel");
    });

    it("prefers request context city over stored city", () => {
        const place = mapSightseeingRowToPlace(
            {
                wikidata_id: "Q1",
                name: "Place",
                type: "LANDMARK",
                city: "Stored",
                lat: 1,
                lng: 2,
                distance_m: 0,
                sitelinks: 1,
            },
            { city: "FromGeocode" },
        );
        expect(place.city).toBe("FromGeocode");
    });
});

describe("seed SPARQL helpers", () => {
    it("builds a country-scoped quality SPARQL query", () => {
        const sparql = buildCountrySightseeingSparql({
            countryQid: "Q235",
            minSitelinks: 1,
            pageSize: 100,
            offset: 0,
        });
        expect(sparql).toContain("wd:Q235");
        expect(sparql).toContain("LIMIT 100");
        expect(sparql).toContain("wikibase:sitelinks");
    });

    it("includes bbox filters when bounds are provided", () => {
        const sparql = buildCountrySightseeingSparql({
            countryQid: "Q159",
            minSitelinks: 2,
            pageSize: 50,
            offset: 100,
            bounds: { minLon: 20, maxLon: 60, minLat: 40, maxLat: 70 },
        });
        expect(sparql).toContain("geof:longitude(?location) >= 20");
        expect(sparql).toContain("geof:longitude(?location) < 60");
        expect(sparql).toContain("OFFSET 100");
    });

    it("supports an exclusive max sitelinks bound for range passes", () => {
        const sparql = buildCountrySightseeingSparql({
            countryQid: "Q142",
            minSitelinks: 5,
            maxSitelinks: 15,
            pageSize: 500,
            offset: 0,
        });
        expect(sparql).toContain("FILTER(?sitelinks >= 5 && ?sitelinks < 15)");
    });

    it("force-tiles France/Germany/Italy by default with tight bboxes", () => {
        expect(shouldForceTileSeed({ name: "France", wikidataId: "Q142" })).toBe(true);
        expect(shouldForceTileSeed({ name: "Malta", wikidataId: "Q233" })).toBe(false);
        expect(shouldForceTileSeed({ name: "Malta", wikidataId: "Q233" }, true)).toBe(true);

        const france = countrySightseeingBounds({ name: "France", wikidataId: "Q142" });
        expect(france).toEqual(COUNTRY_SIGHTSEEING_BOUNDS.Q142);
        expect(france.maxLon - france.minLon).toBeLessThan(20);
    });

    it("maps a Wikidata binding into a sightseeing row", () => {
        const row = bindingToSightseeingRow({
            item: { value: "http://www.wikidata.org/entity/Q243" },
            itemLabel: { value: "Eiffel Tower" },
            location: { value: "Point(2.2945 48.8584)" },
            categoryLabel: { value: "tower" },
            sitelinks: { value: "180" },
            countryCode: { value: "FR" },
            countryLabel: { value: "France" },
            image: { value: "http://commons.example/eiffel.jpg" },
        });
        expect(row).toMatchObject({
            wikidata_id: "Q243",
            name: "Eiffel Tower",
            country_code: "FR",
            lat: 48.8584,
            lng: 2.2945,
            sitelinks: 180,
        });
        expect(row?.type).toBeTruthy();
    });

    it("drops bindings outside country bounds", () => {
        const row = bindingToSightseeingRow(
            {
                item: { value: "http://www.wikidata.org/entity/Q1" },
                itemLabel: { value: "Far East" },
                location: { value: "Point(100 50)" },
                categoryLabel: { value: "landmark" },
                sitelinks: { value: "10" },
            },
            { maxLon: 60 },
        );
        expect(row).toBeNull();
    });
});

describe("sightseeing-db url resolution", () => {
    const prevSecret = process.env.SIGHTSEEING_DATABASE_URL;
    const prevDb = process.env.DATABASE_URL;

    beforeEach(() => {
        resetSightseeingPoolForTests();
        delete process.env.SIGHTSEEING_DATABASE_URL;
        delete process.env.DATABASE_URL;
    });

    afterEach(() => {
        resetSightseeingPoolForTests();
        if (prevSecret === undefined) delete process.env.SIGHTSEEING_DATABASE_URL;
        else process.env.SIGHTSEEING_DATABASE_URL = prevSecret;
        if (prevDb === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = prevDb;
    });

    it("prefers SIGHTSEEING_DATABASE_URL over DATABASE_URL", () => {
        process.env.DATABASE_URL = "postgresql://local/db";
        process.env.SIGHTSEEING_DATABASE_URL = "postgresql://secret/db";
        expect(resolveSightseeingDatabaseUrl()).toBe("postgresql://secret/db");
    });

    it("falls back to DATABASE_URL", () => {
        process.env.DATABASE_URL = "postgresql://local/db";
        expect(resolveSightseeingDatabaseUrl()).toBe("postgresql://local/db");
    });
});

describe("findNearbySightseeing SQL order", () => {
    it("orders by sitelinks for Explore and distance for check-in", async () => {
        const queryMock = vi.fn().mockResolvedValue({
            rows: [
                {
                    wikidata_id: "Q1",
                    name: "A",
                    type: "LANDMARK",
                    country_code: "DE",
                    country: "Germany",
                    city: null,
                    sitelinks: 50,
                    image_url: null,
                    wikipedia_url: null,
                    lat: 52.5,
                    lng: 13.4,
                    distance_m: 100,
                },
            ],
        });

        vi.resetModules();
        vi.doMock("./sightseeing-db.mjs", () => ({
            sightseeingQuery: queryMock,
            getSightseeingPool: vi.fn(),
            closeSightseeingPool: vi.fn(),
            resolveSightseeingDatabaseUrl: vi.fn(),
            resetSightseeingPoolForTests: vi.fn(),
        }));

        const { findNearbySightseeing } = await import("./sightseeing-query.mjs");

        await findNearbySightseeing(52.5, 13.4, { orderBy: "sitelinks", limit: 10 });
        expect(queryMock.mock.calls[0][0]).toContain("sitelinks DESC");

        await findNearbySightseeing(52.5, 13.4, { orderBy: "distance", limit: 10 });
        expect(queryMock.mock.calls[1][0]).toContain("distance_m ASC");

        vi.doUnmock("./sightseeing-db.mjs");
        vi.resetModules();
    });
});
