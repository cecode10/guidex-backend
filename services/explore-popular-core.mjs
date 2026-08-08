import {
    logExternalApiRequest,
    logExternalApiResponse,
} from "./external-api-debug.mjs";
import {
    countryCodeFromGeocodeResult,
    deriveGeoLocationLabel,
    flagFromIsoCode,
    geoLocationPopularKeyFromCoords,
} from "./geo-location-utils.mjs";
import { NEARBY_RADIUS_KM } from "./places-lookup-utils.mjs";
import { resolveExplorePopularPlacesFromDb } from "./sightseeing-query.mjs";

export const GOOGLE_GEOCODE_TIMEOUT_MS = 12_000;
export const GOOGLE_REVERSE_GEOCODE_TIMEOUT_MS = 12_000;

/**
 * @param {string} address
 * @param {string} language
 * @param {string} apiKey
 * @returns {Promise<{ status: string, results?: Array<Record<string, unknown>> }>}
 */
export const fetchGoogleGeocode = async (address, language, apiKey) => {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("language", language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_GEOCODE_TIMEOUT_MS);
    try {
        logExternalApiRequest(
            "google-geocoding",
            `forward-geocode query="${address}" language=${language}`,
        );
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            logExternalApiResponse(
                "google-geocoding",
                `HTTP ${response.status} forward-geocode query="${address}"`,
            );
            throw new Error(`Google Geocoding HTTP ${response.status}`);
        }
        const body = /** @type {{ status: string, results?: Array<Record<string, unknown>> }} */ (
            await response.json()
        );
        logExternalApiResponse(
            "google-geocoding",
            `status=${body.status} forward-geocode query="${address}"`,
        );
        return body;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {string} language
 * @param {string} apiKey
 * @returns {Promise<{ status: string, results?: Array<Record<string, unknown>> }>}
 */
export const fetchGoogleReverseGeocode = async (lat, lng, language, apiKey) => {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("language", language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_REVERSE_GEOCODE_TIMEOUT_MS);
    try {
        logExternalApiRequest(
            "google-geocoding",
            `reverse-geocode lat=${lat} lng=${lng} language=${language}`,
        );
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            logExternalApiResponse(
                "google-geocoding",
                `HTTP ${response.status} reverse-geocode lat=${lat} lng=${lng}`,
            );
            throw new Error(`Google reverse geocode HTTP ${response.status}`);
        }
        const body = /** @type {{ status: string, results?: Array<Record<string, unknown>> }} */ (
            await response.json()
        );
        logExternalApiResponse(
            "google-geocoding",
            `status=${body.status} reverse-geocode lat=${lat} lng=${lng}`,
        );
        return body;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {Record<string, unknown>} best
 * @param {number} fallbackLat
 * @param {number} fallbackLng
 * @returns {{
 *   label: string,
 *   city: string,
 *   countryCode: string | null,
 *   countryFlag: string,
 *   resolvedLat: number,
 *   resolvedLng: number,
 * }}
 */
export const geoMetadataFromGeocodeResult = (best, fallbackLat, fallbackLng) => {
    const label = deriveGeoLocationLabel(best);
    const geometry = /** @type {{ location?: { lat?: number, lng?: number } }} */ (
        best.geometry ?? {}
    );
    const resolvedLat = geometry.location?.lat ?? fallbackLat;
    const resolvedLng = geometry.location?.lng ?? fallbackLng;
    const city =
        label.split(",").map((part) => part.trim()).filter(Boolean)[0] ?? label;
    const countryCode = countryCodeFromGeocodeResult(best);
    const countryFlag = flagFromIsoCode(countryCode ?? "");
    return { label, city, countryCode, countryFlag, resolvedLat, resolvedLng };
};

/**
 * True when a forward Google geocode result already has city + country metadata,
 * so a reverse-geocode round trip can be skipped.
 *
 * @param {Record<string, unknown>} geocodeResult
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export const forwardGeocodeHasLocalityMetadata = (geocodeResult, lat, lng) => {
    const { city, countryCode } = geoMetadataFromGeocodeResult(geocodeResult, lat, lng);
    return Boolean(city.trim() && countryCode && String(countryCode).length === 2);
};

/**
 * @param {unknown} error
 * @returns {number}
 */
export const explorePopularHttpStatus = (error) => {
    if (typeof /** @type {{ statusCode?: number }} */ (error)?.statusCode === "number") {
        return /** @type {{ statusCode: number }} */ (error).statusCode;
    }
    if (/** @type {{ name?: string }} */ (error)?.name === "WikidataSparqlTransientError") {
        return 504;
    }
    return 500;
};

/**
 * Loads popular places for a geo anchor from PostGIS (Europe sightseeing table).
 * Keeps the historical function name for callers; Firestore geo-location cache
 * and live Wikidata SPARQL are no longer used on the request path.
 *
 * @param {{
 *   functionName: string,
 *   key: string,
 *   lat: number,
 *   lng: number,
 *   radiusKm: number,
 *   searchQuery?: string,
 *   label: string,
 *   city: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   resolvedLat: number,
 *   resolvedLng: number,
 *   forceRefresh?: boolean,
 *   language?: string,
 *   apiKey?: string,
 *   cacheSource?: string,
 *   sparqlProfile?: string,
 *   sparqlTimeoutMs?: number,
 *   sparqlMaxAttempts?: number,
 *   sparqlRadiusKm?: number,
 *   sparqlFetchLimit?: number,
 * }} options
 * @returns {Promise<{ key: string, label: string, lat: number, lon: number, places: Array<Record<string, unknown>>, radiusKm: number, cached: boolean }>}
 */
export const resolveExplorePopularPlaces = async (options) =>
    resolveExplorePopularPlacesFromDb({
        functionName: options.functionName,
        key: options.key,
        lat: options.lat,
        lng: options.lng,
        radiusKm: options.radiusKm,
        label: options.label,
        city: options.city,
        countryCode: options.countryCode,
        countryFlag: options.countryFlag,
        resolvedLat: options.resolvedLat,
        resolvedLng: options.resolvedLng,
    });

export {
    geoLocationPopularKeyFromCoords,
    NEARBY_RADIUS_KM,
};
