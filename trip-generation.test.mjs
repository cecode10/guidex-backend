import { describe, expect, it } from "vitest";
import {
    buildTripPrompts,
    filterPlacesByTripTypes,
    groundTripStops,
    normalizeStopCount,
    normalizeTripRadiusKm,
    normalizeTripTypes,
    parseTripJsonFromModel,
    placeMatchesTripType,
    routeLengthMeters,
    tripSearchRadiusKm,
} from "./trip-generation.mjs";

describe("normalizeTripTypes", () => {
    it("keeps only allowed unique types", () => {
        expect(
            normalizeTripTypes(["museum", "LANDMARK", "museum", "cafe"]),
        ).toEqual(["MUSEUM", "LANDMARK"]);
    });
});

describe("normalizeStopCount", () => {
    it("accepts 3/5/7/8/10 only", () => {
        expect(normalizeStopCount(5)).toBe(5);
        expect(normalizeStopCount("3")).toBe(3);
        expect(normalizeStopCount(7)).toBe(7);
        expect(normalizeStopCount(10)).toBe(10);
        expect(normalizeStopCount(4)).toBeNull();
    });
});

describe("normalizeTripRadiusKm", () => {
    it("converts meters and rejects out of range", () => {
        expect(normalizeTripRadiusKm(2000, null)).toBe(2);
        expect(normalizeTripRadiusKm(15000, null)).toBe(15);
        expect(normalizeTripRadiusKm(12500, null)).toBe(12.5);
        expect(normalizeTripRadiusKm(1000, null)).toBeNull();
        expect(normalizeTripRadiusKm(500, null)).toBeNull();
        expect(normalizeTripRadiusKm(null, 5)).toBe(5);
        expect(normalizeTripRadiusKm(null, 15)).toBe(15);
    });
});

describe("tripSearchRadiusKm", () => {
    it("adds 10% tolerance", () => {
        expect(tripSearchRadiusKm(10)).toBe(11);
        expect(tripSearchRadiusKm(2)).toBeCloseTo(2.2);
        expect(tripSearchRadiusKm(5)).toBeCloseTo(5.5);
    });
});

describe("placeMatchesTripType", () => {
    it("matches museum via type or categoryLabel", () => {
        expect(
            placeMatchesTripType({ type: "LANDMARK", categoryLabel: "Art museum" }, "MUSEUM"),
        ).toBe(true);
        expect(placeMatchesTripType({ type: "MUSEUM" }, "MUSEUM")).toBe(true);
        expect(placeMatchesTripType({ type: "PARK" }, "MUSEUM")).toBe(false);
    });
});

describe("filterPlacesByTripTypes", () => {
    it("filters to requested types", () => {
        const places = [
            { wikidataId: "Q1", type: "LANDMARK" },
            { wikidataId: "Q2", type: "PARK" },
            { wikidataId: "Q3", type: "MUSEUM" },
        ];
        expect(filterPlacesByTripTypes(places, ["PARK", "MUSEUM"]).map((p) => p.wikidataId)).toEqual([
            "Q2",
            "Q3",
        ]);
    });
});

describe("parseTripJsonFromModel", () => {
    it("parses plain and fenced JSON", () => {
        expect(parseTripJsonFromModel('{"title":"A","stops":[]}')).toMatchObject({
            title: "A",
        });
        expect(
            parseTripJsonFromModel('Here you go:\n```json\n{"title":"B","stops":[]}\n```'),
        ).toMatchObject({ title: "B" });
    });

    it("throws on invalid JSON", () => {
        expect(() => parseTripJsonFromModel("not json")).toThrow(/valid JSON/);
    });
});

describe("groundTripStops", () => {
    const candidates = [
        { wikidataId: "Q1", name: "One", type: "LANDMARK", distance: 10 },
        { wikidataId: "Q2", name: "Two", type: "MUSEUM", distance: 20 },
        { wikidataId: "Q3", name: "Three", type: "PARK", distance: 30 },
    ];

    it("maps model picks onto candidates, drops unknowns, and pads to stopCount", () => {
        const trip = groundTripStops(
            {
                title: "City stroll",
                summary: "A short walk",
                stops: [
                    { wikidataId: "Q2", why: "Great museum" },
                    { wikidataId: "Q999", why: "fake" },
                    { wikidataId: "Q1", why: "Iconic" },
                ],
            },
            candidates,
            3,
        );
        expect(trip.title).toBe("City stroll");
        expect(trip.stops.map((s) => s.wikidataId)).toEqual(["Q2", "Q1", "Q3"]);
        expect(trip.stops[0].why).toBe("Great museum");
    });

    it("pads a single model stop preferring higher sitelinks", () => {
        const ranked = [
            { wikidataId: "Q1", name: "One", type: "LANDMARK", distance: 10, sitelinks: 50 },
            { wikidataId: "Q2", name: "Two", type: "MUSEUM", distance: 20, sitelinks: 200 },
            { wikidataId: "Q3", name: "Three", type: "PARK", distance: 30, sitelinks: 80 },
        ];
        const trip = groundTripStops(
            {
                title: "Tiny",
                summary: "One pick",
                stops: [{ wikidataId: "Q2", why: "Only this" }],
            },
            ranked,
            5,
        );
        expect(trip.stops.length).toBe(3);
        expect(trip.stops[0].wikidataId).toBe("Q2");
        // Pad order: remaining by sitelinks desc → Q3 (80) then Q1 (50)
        expect(trip.stops.map((s) => s.wikidataId)).toEqual(["Q2", "Q3", "Q1"]);
    });

    it("keeps total walking distance within budget and may return fewer stops", () => {
        // ~111m per 0.001° latitude — Far is ~2.2km from user
        const clustered = [
            {
                wikidataId: "Q1",
                name: "Near",
                lat: 48.8605,
                lng: 2.35,
                sitelinks: 50,
            },
            {
                wikidataId: "Q2",
                name: "Mid",
                lat: 48.861,
                lng: 2.35,
                sitelinks: 200,
            },
            {
                wikidataId: "Q3",
                name: "Far",
                lat: 48.88,
                lng: 2.35,
                sitelinks: 300,
            },
        ];
        const trip = groundTripStops(
            {
                title: "Budget walk",
                summary: "Stay short",
                stops: [
                    { wikidataId: "Q3", why: "Far but famous" },
                    { wikidataId: "Q2", why: "Mid" },
                    { wikidataId: "Q1", why: "Near" },
                ],
            },
            clustered,
            3,
            { userLat: 48.86, userLng: 2.35, maxMeters: 500 },
        );
        expect(routeLengthMeters(48.86, 2.35, trip.stops)).toBeLessThanOrEqual(
            500,
        );
        expect(trip.stops.every((s) => s.wikidataId !== "Q3")).toBe(true);
        expect(trip.stops.length).toBeGreaterThanOrEqual(1);
    });

    it("packs multiple nearby stops under a larger budget", () => {
        const clustered = [
            {
                wikidataId: "Q1",
                name: "A",
                lat: 48.8602,
                lng: 2.35,
                sitelinks: 40,
            },
            {
                wikidataId: "Q2",
                name: "B",
                lat: 48.8605,
                lng: 2.35,
                sitelinks: 80,
            },
            {
                wikidataId: "Q3",
                name: "C",
                lat: 48.8608,
                lng: 2.35,
                sitelinks: 60,
            },
            {
                wikidataId: "Q4",
                name: "Far",
                lat: 48.95,
                lng: 2.35,
                sitelinks: 500,
            },
        ];
        const trip = groundTripStops(
            {
                title: "Cluster",
                summary: "Nearby",
                stops: [{ wikidataId: "Q4", why: "Famous but far" }],
            },
            clustered,
            3,
            { userLat: 48.86, userLng: 2.35, maxMeters: 5500 },
        );
        expect(trip.stops.length).toBe(3);
        // ~10km away — cannot fit under 5.5km budget
        expect(trip.stops.every((s) => s.wikidataId !== "Q4")).toBe(true);
        expect(routeLengthMeters(48.86, 2.35, trip.stops)).toBeLessThanOrEqual(
            5500,
        );
    });
});

describe("buildTripPrompts", () => {
    it("asks for path budget and real places only", () => {
        const { systemPrompt, userPrompt } = buildTripPrompts({
            stopCount: 5,
            radiusKm: 5,
            searchRadiusKm: 5.5,
            preference: "with kids",
            language: "english",
            userLat: 48.86,
            userLng: 2.35,
            candidates: [
                {
                    wikidataId: "Q1",
                    name: "Park",
                    type: "PARK",
                    sitelinks: 120,
                    distance: 200,
                    lat: 48.861,
                    lng: 2.351,
                    city: "Paris",
                },
            ],
        });
        expect(systemPrompt).toMatch(/Never invent|PATH BUDGET/i);
        expect(systemPrompt).toMatch(/5\.5 km|≤ 5\.5/i);
        expect(userPrompt).toContain("48.86, 2.35");
        expect(userPrompt).toContain("with kids");
        expect(userPrompt).toMatch(/Maximum total walking distance/i);
        expect(userPrompt).toContain("rating=120");
    });
});
