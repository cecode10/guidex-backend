/** @typedef {"ready" | "notFound"} GeocodeAnchorStatus */

export const COLLECTION = "geocode-anchors";

/** Maps app i18n language keys to Google Geocoding ISO 639-1 codes. */
export const APP_LANGUAGE_TO_GEOCODE = {
    english: "en",
    german: "de",
    french: "fr",
    spanish: "es",
    italian: "it",
    portuguese: "pt",
    dutch: "nl",
    polish: "pl",
    swedish: "sv",
    danish: "da",
    norwegian: "nb",
    finnish: "fi",
    czech: "cs",
    slovak: "sk",
    hungarian: "hu",
    romanian: "ro",
    bulgarian: "bg",
    croatian: "hr",
    serbian: "sr",
    slovenian: "sl",
    greek: "el",
    ukrainian: "uk",
    lithuanian: "lt",
    latvian: "lv",
    estonian: "et",
    turkish: "tr",
    russian: "ru",
};

const CONTAINER_GEOCODE_TYPES = new Set([
    "locality",
    "postal_town",
    "administrative_area_level_1",
    "administrative_area_level_2",
    "administrative_area_level_3",
    "country",
    "sublocality",
    "sublocality_level_1",
]);

/**
 * Normalizes a free-form search query into a stable Firestore doc id / cache key.
 * Must stay in sync with Dart `normalizeGeocodeKey`.
 *
 * @param {string} query
 * @returns {string}
 */
export const normalizeGeocodeKey = (query) =>
    String(query || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * @param {string | undefined | null} appLanguage
 * @returns {string}
 */
export const geocodingLanguageFromAppLanguage = (appLanguage) => {
    const key = String(appLanguage || "")
        .trim()
        .toLowerCase();
    return APP_LANGUAGE_TO_GEOCODE[key] || "en";
};

/**
 * @param {string[] | undefined | null} types
 * @returns {number}
 */
export const deriveRadiusKm = (types) => {
    const list = Array.isArray(types) ? types : [];
    if (list.some((type) => CONTAINER_GEOCODE_TYPES.has(type))) {
        return 10;
    }
    return 2;
};

/**
 * @param {Record<string, unknown> | undefined | null} data
 * @returns {boolean}
 */
export const isReadyAnchorDoc = (data) =>
    data != null && data.status === "ready" && typeof data.lat === "number" && typeof data.lng === "number";
