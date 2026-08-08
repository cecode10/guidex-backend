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

/** Minimum Explore search radius; keep in sync with NEARBY_RADIUS_KM in places-lookup-utils.mjs */
export const POPULAR_SEARCH_MIN_RADIUS_KM = 3;

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
 * Wikidata radius for Explore search from Google geocode types. POI anchors stay
 * at least [POPULAR_SEARCH_MIN_RADIUS_KM] wide; localities use 10 km.
 *
 * @param {string[] | undefined | null} types
 * @returns {number}
 */
export const popularSearchRadiusKmFromGeocodeTypes = (types) =>
    Math.max(deriveRadiusKm(types), POPULAR_SEARCH_MIN_RADIUS_KM);
