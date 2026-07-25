import { describe, expect, it, vi, afterEach } from "vitest";
import {
    bindingToSightseeingRowForQid,
    buildSightseeingByQidSparql,
    parseHiddenQid,
    parseWikidataQid,
} from "./ensure-sightseeing-by-qid.mjs";

describe("parseHiddenQid", () => {
    it("accepts capital Q followed by at least two digits", () => {
        expect(parseHiddenQid("Q12")).toBe("Q12");
        expect(parseHiddenQid("Q243")).toBe("Q243");
        expect(parseHiddenQid("  Q123456  ")).toBe("Q123456");
    });

    it("ignores trailing junk after the QID digits", () => {
        expect(parseHiddenQid("Q123456 already there")).toBe("Q123456");
        expect(parseHiddenQid("Q99abc")).toBe("Q99");
    });

    it("rejects lowercase q, single digit, or non-Q prefixes", () => {
        expect(parseHiddenQid("q243")).toBeNull();
        expect(parseHiddenQid("Q1")).toBeNull();
        expect(parseHiddenQid("Eiffel")).toBeNull();
        expect(parseHiddenQid("")).toBeNull();
    });
});

describe("parseWikidataQid", () => {
    it("accepts any Q + digits and normalizes case / wd: prefix", () => {
        expect(parseWikidataQid("Q1")).toBe("Q1");
        expect(parseWikidataQid("q243")).toBe("Q243");
        expect(parseWikidataQid("wd:Q243")).toBe("Q243");
    });

    it("rejects junk", () => {
        expect(parseWikidataQid("Q243 trailing")).toBeNull();
        expect(parseWikidataQid("Eiffel")).toBeNull();
    });
});

describe("buildSightseeingByQidSparql", () => {
    it("binds the given entity and requires coordinates", () => {
        const sparql = buildSightseeingByQidSparql("Q243");
        expect(sparql).toContain("BIND(wd:Q243 AS ?item)");
        expect(sparql).toContain("wdt:P625 ?location");
        expect(sparql).toContain("wikibase:label");
    });
});

describe("bindingToSightseeingRowForQid", () => {
    it("maps a Wikidata binding into a sightseeing row", () => {
        const row = bindingToSightseeingRowForQid({
            item: { value: "http://www.wikidata.org/entity/Q243" },
            itemLabel: { value: "Eiffel Tower" },
            location: { value: "Point(2.2945 48.8584)" },
            categoryLabel: { value: "tower" },
            sitelinks: { value: "180" },
            countryLabel: { value: "France" },
            countryCode: { value: "fr" },
            image: {
                value: "http://commons.wikimedia.org/wiki/Special:FilePath/Tour.jpg",
            },
        });
        expect(row).toMatchObject({
            wikidata_id: "Q243",
            name: "Eiffel Tower",
            sitelinks: 180,
            country_code: "FR",
            country: "France",
            lat: 48.8584,
            lng: 2.2945,
            wikipedia_url: null,
        });
    });

    it("rejects bindings without coordinates", () => {
        expect(
            bindingToSightseeingRowForQid({
                item: { value: "http://www.wikidata.org/entity/Q1" },
                itemLabel: { value: "universe" },
            }),
        ).toBeNull();
    });
});

describe("ensureSightseeingByQid", () => {
    afterEach(() => {
        vi.doUnmock("./sightseeing-db.mjs");
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it("returns exists when the QID is already in the DB", async () => {
        const queryMock = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
        vi.resetModules();
        vi.doMock("./sightseeing-db.mjs", () => ({
            sightseeingQuery: queryMock,
            getSightseeingPool: vi.fn(),
            closeSightseeingPool: vi.fn(),
            resolveSightseeingDatabaseUrl: vi.fn(),
            resetSightseeingPoolForTests: vi.fn(),
        }));

        const { ensureSightseeingByQid } = await import("./ensure-sightseeing-by-qid.mjs");
        const result = await ensureSightseeingByQid("Q243 trailing");
        expect(result).toEqual({ status: "exists", wikidataId: "Q243" });
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it("fetches Wikidata and upserts when missing", async () => {
        const queryMock = vi
            .fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        vi.resetModules();
        vi.doMock("./sightseeing-db.mjs", () => ({
            sightseeingQuery: queryMock,
            getSightseeingPool: vi.fn(),
            closeSightseeingPool: vi.fn(),
            resolveSightseeingDatabaseUrl: vi.fn(),
            resetSightseeingPoolForTests: vi.fn(),
        }));

        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                results: {
                    bindings: [
                        {
                            item: { value: "http://www.wikidata.org/entity/Q243" },
                            itemLabel: { value: "Eiffel Tower" },
                            location: { value: "Point(2.2945 48.8584)" },
                            categoryLabel: { value: "tower" },
                            sitelinks: { value: "180" },
                            countryLabel: { value: "France" },
                            countryCode: { value: "fr" },
                        },
                    ],
                },
            }),
        }));

        const { ensureSightseeingByQid } = await import("./ensure-sightseeing-by-qid.mjs");
        const result = await ensureSightseeingByQid("Q243", { fetchImpl });
        expect(result).toEqual({
            status: "added",
            wikidataId: "Q243",
            name: "Eiffel Tower",
        });
        expect(queryMock).toHaveBeenCalledTimes(2);
        expect(String(queryMock.mock.calls[1][0])).toContain("INSERT INTO sightseeing");
        expect(queryMock.mock.calls[1][1][0]).toBe("Q243");
    });

    it("supports dry-run without writing", async () => {
        const queryMock = vi.fn().mockResolvedValue({ rows: [] });
        vi.resetModules();
        vi.doMock("./sightseeing-db.mjs", () => ({
            sightseeingQuery: queryMock,
            getSightseeingPool: vi.fn(),
            closeSightseeingPool: vi.fn(),
            resolveSightseeingDatabaseUrl: vi.fn(),
            resetSightseeingPoolForTests: vi.fn(),
        }));

        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                results: {
                    bindings: [
                        {
                            item: { value: "http://www.wikidata.org/entity/Q243" },
                            itemLabel: { value: "Eiffel Tower" },
                            location: { value: "Point(2.2945 48.8584)" },
                            categoryLabel: { value: "tower" },
                            sitelinks: { value: "180" },
                            countryLabel: { value: "France" },
                            countryCode: { value: "fr" },
                        },
                    ],
                },
            }),
        }));

        const { ensureSightseeingByQid } = await import("./ensure-sightseeing-by-qid.mjs");
        const result = await ensureSightseeingByQid("Q243", {
            fetchImpl,
            dryRun: true,
        });
        expect(result).toEqual({
            status: "would_add",
            wikidataId: "Q243",
            name: "Eiffel Tower",
        });
        expect(queryMock).toHaveBeenCalledTimes(1);
    });
});
