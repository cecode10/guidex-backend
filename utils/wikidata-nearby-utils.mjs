import { flagFromIsoCode, MAX_NEARBY_RESULTS } from "./geo-location-utils.mjs";
import {
    NEARBY_RADIUS_KM,
    WIKIDATA_SPARQL_MAX_ATTEMPTS,
    WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS,
    buildExplorePopularPlacesSparql,
    buildNearbyPlacesSparql,
    classifyPlaceTypeFromCategory,
    mapBindingsToPlaces,
    parseWktPoint,
    readSparqlBinding,
    runWikidataSparql,
    sparqlTimeoutMsForRadius,
    wikidataIdFromItemUri,
} from "./places-lookup-utils.mjs";

export { SPARQL_POI_CATEGORIES } from "./places-lookup-utils.mjs";
export { NEARBY_RADIUS_KM };
export const SPARQL_FETCH_LIMIT = 100;
/** Wider fetch for batch seeding; results are still capped to MAX_NEARBY_RESULTS. */
export const SPARQL_QUALITY_FETCH_LIMIT = 150;
/** Lighter quality fetch for dense metros (Paris, London, Berlin, …). */
export const SPARQL_METRO_FETCH_LIMIT = 75;
/** SPARQL query radius for metro fallback; cache doc id still uses geocode radius (r10). */
export const METRO_FALLBACK_SPARQL_RADIUS_KM = 5;
export const WIKIDATA_SPARQL_QUALITY_TIMEOUT_MS = 120_000;
export const WIKIDATA_SPARQL_QUALITY_MAX_ATTEMPTS = 5;

/** @type {{ FAST: "fast", QUALITY: "quality" }} */
export const SPARQL_PROFILE = {
    FAST: "fast",
    QUALITY: "quality",
};

/**
 * @param {unknown} value
 * @returns {value is typeof SPARQL_PROFILE[keyof typeof SPARQL_PROFILE]}
 */
export const isValidSparqlProfile = (value) =>
    value === SPARQL_PROFILE.FAST || value === SPARQL_PROFILE.QUALITY;

/**
 * @param {unknown} value
 * @returns {typeof SPARQL_PROFILE.FAST | typeof SPARQL_PROFILE.QUALITY}
 */
export const normalizeSparqlProfile = (value) =>
    isValidSparqlProfile(value) ? value : SPARQL_PROFILE.FAST;

export {
    readSparqlBinding,
    parseWktPoint,
    wikidataIdFromItemUri,
    classifyPlaceTypeFromCategory,
};

/**
 * @param {Array<Record<string, unknown>>} bindings
 * @param {{
 *   lat: number,
 *   lng: number,
 *   city: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   limit?: number,
 * }} context
 * @returns {Array<Record<string, unknown>>}
 */
export const mapWikidataBindingsToPlaces = (
    bindings,
    { lat, lng, city, countryCode = null, countryFlag, limit = MAX_NEARBY_RESULTS },
) => {
    const places = mapBindingsToPlaces(bindings, {
        lat,
        lng,
        city,
        countryCode,
        countryFlag: countryFlag ?? flagFromIsoCode(countryCode ?? ""),
    });

    places.sort((a, b) => {
        const byLinks = (b.sitelinks ?? 0) - (a.sitelinks ?? 0);
        if (byLinks !== 0) return byLinks;
        return (a.distance ?? 0) - (b.distance ?? 0);
    });

    return places.slice(0, limit);
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} [radiusKm]
 * @param {number} [fetchLimit]
 * @returns {string}
 */
export const buildNearbyPopularPlacesSparql = (
    lat,
    lng,
    radiusKm = NEARBY_RADIUS_KM,
    fetchLimit = SPARQL_FETCH_LIMIT,
) =>
    buildNearbyPlacesSparql(lat, lng, {
        radiusKm,
        fetchLimit,
        orderBy: "popularity",
    });

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @returns {string}
 */
export const buildGlobalSearchPopularPlacesSparql = (lat, lng, radiusKm) =>
    buildExplorePopularPlacesSparql(lat, lng, radiusKm);

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @param {typeof SPARQL_PROFILE.FAST | typeof SPARQL_PROFILE.QUALITY} [sparqlProfile]
 * @param {number} [fetchLimit]
 * @returns {string}
 */
export const buildPopularPlacesSparqlForProfile = (
    lat,
    lng,
    radiusKm,
    sparqlProfile = SPARQL_PROFILE.FAST,
    fetchLimit,
) => {
    const profile = normalizeSparqlProfile(sparqlProfile);
    if (profile === SPARQL_PROFILE.QUALITY) {
        return buildNearbyPopularPlacesSparql(
            lat,
            lng,
            radiusKm,
            fetchLimit ?? SPARQL_QUALITY_FETCH_LIMIT,
        );
    }
    return buildGlobalSearchPopularPlacesSparql(lat, lng, radiusKm);
};

/**
 * @param {{
 *   sparqlProfile?: string,
 *   globalSearch?: boolean,
 *   radiusKm?: number,
 *   sparqlTimeoutMs?: number,
 *   sparqlMaxAttempts?: number,
 * }} [options]
 * @returns {{ timeoutMs: number, maxAttempts: number }}
 */
export const resolveSparqlFetchOptions = ({
    sparqlProfile = SPARQL_PROFILE.FAST,
    globalSearch = false,
    radiusKm = NEARBY_RADIUS_KM,
    sparqlTimeoutMs,
    sparqlMaxAttempts,
} = {}) => {
    const profile = normalizeSparqlProfile(sparqlProfile);
    if (profile === SPARQL_PROFILE.QUALITY) {
        return {
            timeoutMs: sparqlTimeoutMs ?? WIKIDATA_SPARQL_QUALITY_TIMEOUT_MS,
            maxAttempts: sparqlMaxAttempts ?? WIKIDATA_SPARQL_QUALITY_MAX_ATTEMPTS,
        };
    }
    return {
        timeoutMs:
            sparqlTimeoutMs ??
            (globalSearch
                ? WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS
                : sparqlTimeoutMsForRadius(radiusKm)),
        maxAttempts:
            sparqlMaxAttempts ?? (globalSearch ? 1 : WIKIDATA_SPARQL_MAX_ATTEMPTS),
    };
};

/**
 * True when a cached geo-location doc matches the requested SPARQL profile.
 *
 * @param {string | null | undefined} existingProfile
 * @param {typeof SPARQL_PROFILE.FAST | typeof SPARQL_PROFILE.QUALITY} requestedProfile
 * @returns {boolean}
 */
export const sparqlProfileMatchesCache = (existingProfile, requestedProfile) => {
    const requested = normalizeSparqlProfile(requestedProfile);
    if (!existingProfile) {
        return requested === SPARQL_PROFILE.FAST;
    }
    return existingProfile === requested;
};

/**
 * Loads curated nearby POIs from Wikidata SPARQL (landmarks, historic sites, museums, …).
 *
 * @param {number} lat
 * @param {number} lng
 * @param {{
 *   city: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   limit?: number,
 *   radiusKm?: number,
 *   globalSearch?: boolean,
 *   sparqlProfile?: string,
 *   sparqlTimeoutMs?: number,
 *   sparqlMaxAttempts?: number,
 *   sparqlRadiusKm?: number,
 *   sparqlFetchLimit?: number,
 * }} context
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const fetchWikidataNearbyPopularPlaces = async (
    lat,
    lng,
    {
        city,
        countryCode = null,
        countryFlag,
        limit = MAX_NEARBY_RESULTS,
        radiusKm = NEARBY_RADIUS_KM,
        globalSearch = false,
        sparqlProfile = SPARQL_PROFILE.FAST,
        sparqlTimeoutMs,
        sparqlMaxAttempts,
        sparqlRadiusKm,
        sparqlFetchLimit,
    },
    fetchImpl = fetch,
) => {
    const profile = normalizeSparqlProfile(sparqlProfile);
    const queryRadiusKm = sparqlRadiusKm ?? radiusKm;
    const query = buildPopularPlacesSparqlForProfile(
        lat,
        lng,
        queryRadiusKm,
        profile,
        sparqlFetchLimit,
    );
    const { timeoutMs, maxAttempts } = resolveSparqlFetchOptions({
        sparqlProfile: profile,
        globalSearch,
        radiusKm: queryRadiusKm,
        sparqlTimeoutMs,
        sparqlMaxAttempts,
    });
    const bindings = await runWikidataSparql(query, fetchImpl, {
        extra:
            `wikidata-nearby lat=${lat} lng=${lng} radiusKm=${queryRadiusKm} profile=${profile}` +
            (sparqlFetchLimit ? ` fetchLimit=${sparqlFetchLimit}` : "") +
            (globalSearch ? " globalSearch" : ""),
        timeoutMs,
        maxAttempts,
    });
    return mapWikidataBindingsToPlaces(bindings, {
        lat,
        lng,
        city,
        countryCode,
        countryFlag,
        limit,
    });
};
