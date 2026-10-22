import { haversineMeters } from "./trip-generation.mjs";
import { logExternalApiRequest, logExternalApiResponse } from "../utils/external-api-debug.mjs";

/**
 * Named landmarks near the camera from Google Places API (New) Nearby Search.
 * imageStory lists them in the prompt so the model can pick the one the photo shows.
 *
 * Billing: every field in PLACES_FIELD_MASK is in the "Nearby Search Pro" SKU.
 * Adding an Enterprise field (rating, websiteUri, ...) or an Atmosphere field
 * (editorialSummary, reviews, ...) bills the whole request at that higher SKU.
 * Google's terms do not allow caching Places content, so every scan with a
 * location makes one request.
 */

export const PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const PLACES_TIMEOUT_MS = 3_000;

export const MIN_CANDIDATE_RADIUS_M = 150;
export const MAX_CANDIDATE_RADIUS_M = 400;
/** Google returns at most 20; the prompt gets the closest few. */
const MAX_RESULT_COUNT = 20;
export const MAX_CANDIDATES = 8;

export const PLACES_FIELD_MASK = [
    "places.id",
    "places.displayName",
    "places.location",
    "places.primaryType",
    "places.primaryTypeDisplayName",
    "places.types",
    "places.shortFormattedAddress",
    "places.businessStatus",
    "places.googleMapsUri",
    "places.attributions",
].join(",");

/** Types every place has; they tell the model nothing. */
const GENERIC_PLACE_TYPES = new Set(["point_of_interest", "establishment"]);
const MAX_EXTRA_TYPES = 3;

/** Table A types for things people photograph as sights. */
export const LANDMARK_PLACE_TYPES = [
    "historical_landmark",
    "historical_place",
    "cultural_landmark",
    "monument",
    "sculpture",
    "castle",
    "fountain",
    "museum",
    "art_museum",
    "history_museum",
    "art_gallery",
    "church",
    "mosque",
    "synagogue",
    "hindu_temple",
    "buddhist_temple",
    "shinto_shrine",
    "tourist_attraction",
    "plaza",
    "observation_deck",
    "opera_house",
    "amphitheatre",
];

/** App language names (as sent by the mobile app) to Google language codes. */
export const LANGUAGE_NAME_TO_CODE = {
    english: "en",
    bulgarian: "bg",
    croatian: "hr",
    czech: "cs",
    danish: "da",
    dutch: "nl",
    estonian: "et",
    finnish: "fi",
    french: "fr",
    german: "de",
    greek: "el",
    hungarian: "hu",
    italian: "it",
    latvian: "lv",
    lithuanian: "lt",
    norwegian: "no",
    polish: "pl",
    portuguese: "pt",
    romanian: "ro",
    russian: "ru",
    serbian: "sr",
    slovak: "sk",
    slovenian: "sl",
    spanish: "es",
    swedish: "sv",
    turkish: "tr",
    ukrainian: "uk",
};

/**
 * @param {string | null | undefined} language app language name
 * @returns {string}
 */
export const languageCodeFromLanguage = (language) =>
    LANGUAGE_NAME_TO_CODE[String(language ?? "").trim().toLowerCase()] ?? "en";

/**
 * Search radius grows with the GPS accuracy so a poor fix still covers the subject.
 *
 * @param {number | null | undefined} accuracyM
 * @returns {number}
 */
export const candidateRadiusMeters = (accuracyM) => {
    const accuracy = Number(accuracyM);
    const extra = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0;
    return Math.round(Math.min(MIN_CANDIDATE_RADIUS_M + extra, MAX_CANDIDATE_RADIUS_M));
};

/**
 * @param {{ lat: number, lon: number, radiusM: number, languageCode: string }} args
 * @returns {Record<string, unknown>}
 */
export const buildNearbySearchRequest = ({ lat, lon, radiusM, languageCode }) => ({
    includedTypes: LANDMARK_PLACE_TYPES,
    maxResultCount: MAX_RESULT_COUNT,
    rankPreference: "DISTANCE",
    languageCode,
    locationRestriction: {
        circle: {
            center: { latitude: lat, longitude: lon },
            radius: radiusM,
        },
    },
});

/**
 * Secondary types in readable form, e.g. ["church", "place of worship"].
 *
 * @param {unknown} types
 * @param {string | null | undefined} primaryType
 * @returns {string[]}
 */
export const readableExtraTypes = (types, primaryType) =>
    (Array.isArray(types) ? types : [])
        .filter((type) => typeof type === "string" && type !== primaryType && !GENERIC_PLACE_TYPES.has(type))
        .slice(0, MAX_EXTRA_TYPES)
        .map((type) => type.replace(/_/g, " "));

/**
 * Third-party data providers Google asks us to credit, e.g. ["Example Data Co"].
 *
 * @param {unknown} attributions
 * @returns {string[]}
 */
export const attributionProviders = (attributions) =>
    (Array.isArray(attributions) ? attributions : [])
        .map((attribution) => String(attribution?.provider ?? "").trim())
        .filter(Boolean);

/**
 * Maps the Nearby Search response to prompt candidates, closest first.
 * Each candidate gets a short `ref` ("P1", "P2", ...) that the model echoes
 * back in its "ID:" line; Google place ids are too long to ask for reliably.
 *
 * @param {{ places?: Array<Record<string, any>> }} body
 * @param {{ lat: number, lon: number, limit?: number }} origin
 * @returns {Array<Record<string, any>>}
 */
export const parseNearbySearchResponse = (body, { lat, lon, limit = MAX_CANDIDATES }) => {
    const places = Array.isArray(body?.places) ? body.places : [];
    const candidates = [];
    for (const place of places) {
        const name = String(place?.displayName?.text ?? "").trim();
        const pLat = Number(place?.location?.latitude);
        const pLng = Number(place?.location?.longitude);
        if (!name || !Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;
        // A demolished or closed site is not what the camera sees.
        if (place?.businessStatus === "CLOSED_PERMANENTLY") continue;
        const address = String(place?.shortFormattedAddress ?? "").trim();
        candidates.push({
            googlePlaceId: place?.id ?? null,
            name,
            type: String(place?.primaryTypeDisplayName?.text ?? place?.primaryType ?? "landmark"),
            extraTypes: readableExtraTypes(place?.types, place?.primaryType),
            address: address || null,
            lat: pLat,
            lng: pLng,
            distance: Math.round(haversineMeters(lat, lon, pLat, pLng)),
            googleMapsUri: place?.googleMapsUri ?? null,
            attributions: attributionProviders(place?.attributions),
        });
    }
    return candidates
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((candidate, index) => ({ ...candidate, ref: `P${index + 1}` }));
};

/**
 * The candidate fields sent to the app; names match the app's `NearLocation`.
 *
 * @param {Record<string, any>} candidate
 * @returns {Record<string, unknown>}
 */
export const candidateToPlacePayload = (candidate) => ({
    name: candidate.name,
    type: candidate.type,
    categoryLabel: candidate.type,
    distance: candidate.distance,
    address: candidate.address,
    lat: candidate.lat,
    lng: candidate.lng,
    googlePlaceId: candidate.googlePlaceId,
    googleMapsUri: candidate.googleMapsUri,
    attributions: candidate.attributions ?? [],
});

/**
 * @param {{ lat: number, lon: number, accuracy?: number | null, language?: string | null }} location
 * @param {{ apiKey: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ candidates: Array<Record<string, any>>, radiusM: number }>}
 */
export const findNearbyLandmarks = async (
    { lat, lon, accuracy = null, language = null },
    { apiKey, fetchImpl = fetch },
) => {
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured");

    const radiusM = candidateRadiusMeters(accuracy);
    const detail = `nearby ${lat.toFixed(5)},${lon.toFixed(5)} r=${radiusM}m`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
    try {
        logExternalApiRequest("google-places", detail);
        const response = await fetchImpl(PLACES_NEARBY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": PLACES_FIELD_MASK,
            },
            body: JSON.stringify(
                buildNearbySearchRequest({ lat, lon, radiusM, languageCode: languageCodeFromLanguage(language) }),
            ),
            signal: controller.signal,
        });
        logExternalApiResponse("google-places", `HTTP ${response.status} ${detail}`);
        if (!response.ok) {
            // Google's reason (API not enabled, key restricted, ...) stays in the log.
            const reason = await response.text().catch(() => "");
            console.error(`[google-places] HTTP ${response.status}: ${reason.slice(0, 1000)}`);
            throw new Error(`Google Places HTTP ${response.status}`);
        }
        return { candidates: parseNearbySearchResponse(await response.json(), { lat, lon }), radiusM };
    } finally {
        clearTimeout(timer);
    }
};
