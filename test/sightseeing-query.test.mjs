import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mapSightseeingRowToPlace } from "../services/sightseeing-query.mjs";
import {
    resetSightseeingPoolForTests,
    resolveSightseeingDatabaseUrl,
} from "../services/sightseeing-db.mjs";

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
        vi.doMock("../services/sightseeing-db.mjs", () => ({
            sightseeingQuery: queryMock,
            getSightseeingPool: vi.fn(),
            closeSightseeingPool: vi.fn(),
            resolveSightseeingDatabaseUrl: vi.fn(),
            resetSightseeingPoolForTests: vi.fn(),
        }));

        const { findNearbySightseeing } = await import("../services/sightseeing-query.mjs");

        await findNearbySightseeing(52.5, 13.4, { orderBy: "sitelinks", limit: 10 });
        expect(queryMock.mock.calls[0][0]).toContain("sitelinks DESC");

        await findNearbySightseeing(52.5, 13.4, { orderBy: "distance", limit: 10 });
        expect(queryMock.mock.calls[1][0]).toContain("distance_m ASC");

        vi.doUnmock("../services/sightseeing-db.mjs");
        vi.resetModules();
    });
});
