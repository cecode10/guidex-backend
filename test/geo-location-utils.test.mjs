import { describe, expect, it } from "vitest";
import {
    geoLocationKeyFromCoords,
    geoLocationPopularKeyFromCoords,
    geoLocationCacheSourceForWrite,
    GEO_LOCATION_CACHE_SOURCE,
    isValidGeoLocationCacheSource,
} from "../utils/geo-location-utils.mjs";

describe("geo-location cache keys", () => {
    it("keeps coordinate keys at three decimal places", () => {
        expect(geoLocationKeyFromCoords(49.4093582, 8.694724)).toBe("49.409_8.695");
    });

    it("builds popular cache keys as {lat}_{lng}_r{radius}", () => {
        expect(geoLocationPopularKeyFromCoords(41.89021, 12.49223, 3)).toBe(
            "41.890_12.492_r3",
        );
        expect(geoLocationPopularKeyFromCoords(41.89021, 12.49223, 10)).toBe(
            "41.890_12.492_r10",
        );
    });

    it("shares the same r3 key for near-me and POI search at the same coords", () => {
        const nearMe = geoLocationPopularKeyFromCoords(41.3874, 2.1686, 3);
        const search = geoLocationPopularKeyFromCoords(41.3874, 2.1686, 3);
        expect(nearMe).toBe("41.387_2.169_r3");
        expect(search).toBe(nearMe);
    });

    it("uses separate keys for different radii at the same coords", () => {
        expect(geoLocationPopularKeyFromCoords(41.3874, 2.1686, 3)).toBe(
            "41.387_2.169_r3",
        );
        expect(geoLocationPopularKeyFromCoords(41.3874, 2.1686, 10)).toBe(
            "41.387_2.169_r10",
        );
    });

    it("returns empty string when radius is invalid", () => {
        expect(geoLocationPopularKeyFromCoords(49.4093582, 8.694724, 0)).toBe("");
    });
});

describe("geoLocationCacheSourceForWrite", () => {
    it("sets source on first write", () => {
        expect(
            geoLocationCacheSourceForWrite(null, GEO_LOCATION_CACHE_SOURCE.BATCH_SEED),
        ).toBe("batch_seed");
    });

    it("preserves existing source on refresh", () => {
        expect(
            geoLocationCacheSourceForWrite(
                { cacheSource: GEO_LOCATION_CACHE_SOURCE.USER },
                GEO_LOCATION_CACHE_SOURCE.BATCH_SEED,
            ),
        ).toBe("user");
    });

    it("backfills legacy docs without cacheSource", () => {
        expect(
            geoLocationCacheSourceForWrite({}, GEO_LOCATION_CACHE_SOURCE.USER),
        ).toBe("user");
    });

    it("validates known sources", () => {
        expect(isValidGeoLocationCacheSource("batch_seed")).toBe(true);
        expect(isValidGeoLocationCacheSource("user")).toBe(true);
        expect(isValidGeoLocationCacheSource("other")).toBe(false);
    });
});
