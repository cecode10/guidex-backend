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
    },
    fetchImpl = fetch,
) => {
    const query = buildGlobalSearchPopularPlacesSparql(lat, lng, radiusKm);
    const bindings = await runWikidataSparql(query, fetchImpl, {
        extra:
            `wikidata-nearby lat=${lat} lng=${lng} radiusKm=${radiusKm}` +
            (globalSearch ? " globalSearch" : ""),
        timeoutMs: globalSearch
            ? WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS
            : sparqlTimeoutMsForRadius(radiusKm),
        maxAttempts: globalSearch ? 1 : WIKIDATA_SPARQL_MAX_ATTEMPTS,
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
