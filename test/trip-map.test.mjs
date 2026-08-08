import { describe, expect, it } from "vitest";
import {
    buildTripStaticMapUrl,
    extractTripCoordinates,
    TRIP_MAP_SIZE,
} from "../services/trip-map.mjs";

describe("extractTripCoordinates", () => {
    it("keeps finite lat/lng only", () => {
        expect(
            extractTripCoordinates([
                { lat: 48.1, lng: 2.2 },
                { lat: "x", lng: 1 },
                { lat: 49, lng: 3 },
            ]),
        ).toEqual([
            { lat: 48.1, lng: 2.2 },
            { lat: 49, lng: 3 },
        ]);
    });
});

describe("buildTripStaticMapUrl", () => {
    it("returns null without key or coords", () => {
        expect(buildTripStaticMapUrl([{ lat: 1, lng: 2 }], "")).toBeNull();
        expect(buildTripStaticMapUrl([], "key")).toBeNull();
    });

    it("builds a 4:3 static map URL with markers and path", () => {
        const url = buildTripStaticMapUrl(
            [
                { lat: 48.86, lng: 2.29 },
                { lat: 48.86, lng: 2.3 },
                { lat: 48.87, lng: 2.31 },
            ],
            "test-key",
        );
        expect(url).toBeTruthy();
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe(
            "https://maps.googleapis.com/maps/api/staticmap",
        );
        expect(parsed.searchParams.get("size")).toBe(TRIP_MAP_SIZE);
        expect(parsed.searchParams.get("scale")).toBe("2");
        expect(parsed.searchParams.get("key")).toBe("test-key");
        expect(parsed.searchParams.getAll("markers")).toHaveLength(3);
        expect(parsed.searchParams.get("markers")).toContain("label:1");
        expect(parsed.searchParams.get("path")).toContain("48.86,2.29");
        expect(parsed.searchParams.get("path")).toContain("48.87,2.31");
    });
});
