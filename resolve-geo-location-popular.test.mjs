import { describe, expect, it, vi } from "vitest";
import {
    POPULAR_SEARCH_RADIUS_FALLBACK_KM,
} from "./geocode-anchor-utils.mjs";
import {
    derivePopularSearchRadiusKm,
    resolvePopularSearchRadiusKm,
} from "./explore-popular-core.mjs";

describe("resolvePopularSearchRadiusKm", () => {
    it("uses a trusted client radius without geocoding again", async () => {
        const fetchGoogleGeocode = vi.fn();
        await expect(
            resolvePopularSearchRadiusKm(
                "Heidelberg",
                { language: "en", apiKey: "test-key", radiusKm: 10 },
                fetchGoogleGeocode,
            ),
        ).resolves.toBe(10);
        expect(fetchGoogleGeocode).not.toHaveBeenCalled();
    });

    it("clamps an undersized client radius to the nearby minimum", async () => {
        const fetchGoogleGeocode = vi.fn();
        await expect(
            resolvePopularSearchRadiusKm(
                "Colosseum",
                { language: "en", apiKey: "test-key", radiusKm: 2 },
                fetchGoogleGeocode,
            ),
        ).resolves.toBe(3);
        expect(fetchGoogleGeocode).not.toHaveBeenCalled();
    });

    it("derives radius from geocode types when the client omits it", async () => {
        const fetchGoogleGeocode = vi.fn().mockResolvedValue({
            status: "OK",
            results: [{ types: ["locality", "political"] }],
        });
        await expect(
            resolvePopularSearchRadiusKm(
                "Heidelberg",
                { language: "en", apiKey: "test-key" },
                fetchGoogleGeocode,
            ),
        ).resolves.toBe(10);
        expect(fetchGoogleGeocode).toHaveBeenCalledOnce();
    });
});

describe("derivePopularSearchRadiusKm", () => {
    it("falls back to 10 km when geocoding fails", async () => {
        const fetchGoogleGeocode = vi.fn().mockRejectedValue(new Error("timeout"));
        await expect(
            derivePopularSearchRadiusKm(
                "Heidelberg",
                "en",
                "test-key",
                fetchGoogleGeocode,
            ),
        ).resolves.toBe(POPULAR_SEARCH_RADIUS_FALLBACK_KM);
    });

    it("falls back to 10 km when geocoding returns no results", async () => {
        const fetchGoogleGeocode = vi.fn().mockResolvedValue({
            status: "ZERO_RESULTS",
            results: [],
        });
        await expect(
            derivePopularSearchRadiusKm(
                "Nowhere",
                "en",
                "test-key",
                fetchGoogleGeocode,
            ),
        ).resolves.toBe(POPULAR_SEARCH_RADIUS_FALLBACK_KM);
    });
});
