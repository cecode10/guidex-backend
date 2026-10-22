import { describe, expect, it, vi } from "vitest";
import {
    LANDMARK_PLACE_TYPES,
    PLACES_FIELD_MASK,
    PLACES_NEARBY_URL,
    buildNearbySearchRequest,
    candidateRadiusMeters,
    candidateToPlacePayload,
    findNearbyLandmarks,
    languageCodeFromLanguage,
    parseNearbySearchResponse,
} from "./google-places-nearby.mjs";

const LAT = 42.6959;
const LON = 23.3329;
const north = (meters) => LAT + meters / 111_320;

const place = (name, meters, extra = {}) => ({
    id: `id-${name}`,
    displayName: { text: name, languageCode: "en" },
    location: { latitude: north(meters), longitude: LON },
    primaryType: "historical_landmark",
    primaryTypeDisplayName: { text: "Historical landmark" },
    types: ["historical_landmark", "tourist_attraction", "point_of_interest", "establishment"],
    shortFormattedAddress: `${name} Square 1, Sofia`,
    businessStatus: "OPERATIONAL",
    googleMapsUri: `https://maps.google.com/?cid=${name.length}`,
    ...extra,
});

const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

describe("request building", () => {
    it("grows the radius with GPS accuracy within bounds", () => {
        expect(candidateRadiusMeters(null)).toBe(150);
        expect(candidateRadiusMeters(30)).toBe(180);
        expect(candidateRadiusMeters(5000)).toBe(400);
    });

    it("maps app language names to Google language codes", () => {
        expect(languageCodeFromLanguage("bulgarian")).toBe("bg");
        expect(languageCodeFromLanguage("German")).toBe("de");
        expect(languageCodeFromLanguage(undefined)).toBe("en");
    });

    it("asks for landmark types closest first within the circle", () => {
        const request = buildNearbySearchRequest({ lat: LAT, lon: LON, radiusM: 180, languageCode: "bg" });
        expect(request).toEqual({
            includedTypes: LANDMARK_PLACE_TYPES,
            maxResultCount: 20,
            rankPreference: "DISTANCE",
            languageCode: "bg",
            locationRestriction: { circle: { center: { latitude: LAT, longitude: LON }, radius: 180 } },
        });
        expect(LANDMARK_PLACE_TYPES.length).toBeLessThanOrEqual(50);
    });
});

describe("parseNearbySearchResponse", () => {
    it("keeps named open places, sorts by distance, and assigns short refs", () => {
        const body = {
            places: [
                place("Saint Sofia Church", 120, {
                    primaryType: "church",
                    primaryTypeDisplayName: { text: "Church" },
                    types: ["church", "place_of_worship", "tourist_attraction", "historical_landmark", "establishment"],
                }),
                place("Monument", 30),
                place("Old Cinema", 50, { businessStatus: "CLOSED_PERMANENTLY" }),
                { displayName: { text: "No location" } },
                place("", 10),
            ],
        };
        const out = parseNearbySearchResponse(body, { lat: LAT, lon: LON });
        expect(out.map((c) => [c.ref, c.name, c.distance])).toEqual([
            ["P1", "Monument", 30],
            ["P2", "Saint Sofia Church", 120],
        ]);
        expect(out[0]).toMatchObject({
            type: "Historical landmark",
            extraTypes: ["tourist attraction"],
            address: "Monument Square 1, Sofia",
            googlePlaceId: "id-Monument",
            attributions: [],
        });
        // At most three extra types, without the primary or generic ones.
        expect(out[1].extraTypes).toEqual(["place of worship", "tourist attraction", "historical landmark"]);
    });

    it("collects third-party attribution providers", () => {
        const body = {
            places: [place("Monument", 30, { attributions: [{ provider: "Example Data Co", providerUri: "https://x" }, {}] })],
        };
        expect(parseNearbySearchResponse(body, { lat: LAT, lon: LON })[0].attributions).toEqual(["Example Data Co"]);
    });

    it("caps the list for the prompt", () => {
        const body = { places: Array.from({ length: 20 }, (_, i) => place(`P${i}`, i * 5)) };
        expect(parseNearbySearchResponse(body, { lat: LAT, lon: LON })).toHaveLength(8);
        expect(parseNearbySearchResponse({}, { lat: LAT, lon: LON })).toEqual([]);
    });

    it("sends the app NearLocation field names", () => {
        const [candidate] = parseNearbySearchResponse({ places: [place("Monument", 30)] }, { lat: LAT, lon: LON });
        expect(candidateToPlacePayload(candidate)).toEqual({
            name: "Monument",
            type: "Historical landmark",
            categoryLabel: "Historical landmark",
            distance: 30,
            address: "Monument Square 1, Sofia",
            lat: candidate.lat,
            lng: LON,
            googlePlaceId: "id-Monument",
            googleMapsUri: "https://maps.google.com/?cid=8",
            attributions: [],
        });
    });
});

describe("findNearbyLandmarks", () => {
    it("posts the search with the key and field mask", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ places: [place("Monument", 30)] }));
        const result = await findNearbyLandmarks(
            { lat: LAT, lon: LON, accuracy: 20, language: "bulgarian" },
            { apiKey: "test-key", fetchImpl },
        );

        expect(result.radiusM).toBe(170);
        expect(result.candidates.map((c) => c.name)).toEqual(["Monument"]);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(PLACES_NEARBY_URL);
        expect(init.method).toBe("POST");
        expect(init.headers["X-Goog-Api-Key"]).toBe("test-key");
        expect(init.headers["X-Goog-FieldMask"]).toBe(PLACES_FIELD_MASK);
        // Pro SKU only: an Atmosphere field would raise the price of every request.
        expect(PLACES_FIELD_MASK).not.toContain("editorialSummary");
        expect(PLACES_FIELD_MASK).toContain("places.shortFormattedAddress");
        expect(JSON.parse(init.body)).toMatchObject({ languageCode: "bg", locationRestriction: { circle: { radius: 170 } } });
    });

    it("throws on an HTTP error so the handler can fall back", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "API not enabled" } }, 403));
        await expect(
            findNearbyLandmarks({ lat: LAT, lon: LON }, { apiKey: "test-key", fetchImpl }),
        ).rejects.toThrow("Google Places HTTP 403");
    });

    it("requires an API key", async () => {
        await expect(findNearbyLandmarks({ lat: LAT, lon: LON }, { apiKey: "" })).rejects.toThrow(
            "GOOGLE_MAPS_API_KEY is not configured",
        );
    });
});
