import {
    logExternalApiRequestUrl,
    logExternalApiResponseUrl,
} from "./external-api-debug.mjs";
import { flagFromIsoCode, MAX_NEARBY_RESULTS } from "./geo-location-utils.mjs";

/** Matches [PlacesLookupService._sparqlCategories] in the mobile app. */
export const SPARQL_POI_CATEGORIES = `
    wd:Q570116 wd:Q10864048 wd:Q2319498 wd:Q4989906 wd:Q9259 wd:Q10502151 wd:Q839954 wd:Q109607
    wd:Q174782 wd:Q54114 wd:Q8502 wd:Q2031181 wd:Q39715 wd:Q860861
    wd:Q23413 wd:Q170928 wd:Q751876 wd:Q57833 wd:Q213422 wd:Q339042
    wd:Q12280 wd:Q158438 wd:Q3397526 wd:Q1735118 wd:Q811979 wd:Q727024
    wd:Q22698 wd:Q46169 wd:Q165115 wd:Q43501 wd:Q34016 wd:Q35509 wd:Q14674 wd:Q4508
    wd:Q33506 wd:Q207694 wd:Q24354 wd:Q41253 wd:Q153562 wd:Q180846 wd:Q483110
    wd:Q16970 wd:Q32815 wd:Q267596 wd:Q201818 wd:Q1128397 wd:Q1370598 wd:Q849706
    wd:Q194195 wd:Q2416723 wd:Q2870166
`;

/** Matches [PlacesLookupService] nearby radius. */
export const NEARBY_RADIUS_KM = 3;

/** Fetch more than we store, then rank by sitelinks and trim. */
export const SPARQL_FETCH_LIMIT = 100;

export const WIKIDATA_SPARQL_TIMEOUT_MS = 20_000;

const WIKI_HEADERS = {
    "User-Agent": "rambleX-mobile (https://ramblex.app)",
    Accept: "application/sparql-results+json",
};

const HIGHLIGHT_CATEGORIES = new Set([
    "TOURIST ATTRACTION",
    "LANDMARK",
    "ARCHITECTURAL LANDMARK",
    "MONUMENT",
    "WORLD HERITAGE SITE",
    "HISTORIC SITE",
    "ARCHAEOLOGICAL SITE",
    "RUINS",
    "CASTLE",
    "PALACE",
    "CHÂTEAU",
    "FORTRESS",
    "CITY GATE",
    "BRIDGE",
    "MUSEUM",
    "ART MUSEUM",
    "CHURCH BUILDING",
    "CATHEDRAL",
    "MOSQUE",
    "TEMPLE",
    "SYNAGOGUE",
    "MONASTERY",
    "ABBEY",
]);

const HISTORICAL_KEYWORDS = [
    "HISTORIC",
    "CASTLE",
    "ARCHAEOLOGICAL",
    "RUINS",
    "FORTRESS",
    "CHÂTEAU",
    "PALACE",
    "ANCIENT",
    "MONASTERY",
    "ABBEY",
];

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
) => `
SELECT ?item ?itemLabel ?image ?location ?dist ?categoryLabel ?sitelinks ?countryLabel ?countryCode WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  VALUES ?category { ${SPARQL_POI_CATEGORIES} }
  ?item wdt:P31 ?category .
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country wdt:P297 ?countryCode .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ?item wikibase:sitelinks ?sitelinks .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sitelinks) LIMIT ${fetchLimit}
`.trim();

/**
 * @param {Record<string, unknown>} binding
 * @param {string} key
 * @returns {string | null}
 */
export const readSparqlBinding = (binding, key) => {
    const raw = binding?.[key];
    if (raw && typeof raw === "object" && raw !== null && "value" in raw) {
        const value = /** @type {{ value?: unknown }} */ (raw).value;
        return value == null ? null : String(value);
    }
    return null;
};

/**
 * @param {string} wkt
 * @returns {{ lat: number, lng: number } | null}
 */
export const parseWktPoint = (wkt) => {
    const match = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(String(wkt || ""));
    if (!match) return null;
    const lng = Number.parseFloat(match[1]);
    const lat = Number.parseFloat(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
};

/**
 * @param {string} itemUri
 * @returns {string | null}
 */
export const wikidataIdFromItemUri = (itemUri) => {
    const qid = String(itemUri || "").split("/").pop()?.trim() ?? "";
    return /^Q\d+$/.test(qid) ? qid : null;
};

/**
 * @param {string} rawCategory
 * @returns {string}
 */
export const classifyPlaceTypeFromCategory = (rawCategory) => {
    const upper = String(rawCategory || "Point of Interest").toUpperCase();
    const isHighlight = [...HIGHLIGHT_CATEGORIES].some((category) => upper.includes(category));
    if (!isHighlight) return rawCategory || "Point of Interest";
    const isHistorical = HISTORICAL_KEYWORDS.some((keyword) => upper.includes(keyword));
    return isHistorical ? "HISTORICAL" : "LANDMARK";
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
    const seen = new Set();
    const ranked = [];

    for (const binding of bindings) {
        const itemUri = readSparqlBinding(binding, "item") ?? "";
        const wikidataId = wikidataIdFromItemUri(itemUri);
        const name = readSparqlBinding(binding, "itemLabel") ?? "";
        if (
            !wikidataId ||
            !name ||
            /^Q\d+$/.test(name) ||
            name === "Unknown Place" ||
            seen.has(wikidataId)
        ) {
            continue;
        }

        const coords = parseWktPoint(readSparqlBinding(binding, "location") ?? "");
        const placeLat = coords?.lat ?? lat;
        const placeLng = coords?.lng ?? lng;
        const distKm = Number.parseFloat(readSparqlBinding(binding, "dist") ?? "0");
        const distanceMeters = Number.isFinite(distKm) ? Math.round(distKm * 1000) : 0;
        const categoryLabel = readSparqlBinding(binding, "categoryLabel") ?? "Point of Interest";
        const bindingCountryCode = (readSparqlBinding(binding, "countryCode") ?? "").toUpperCase();
        const resolvedCountryCode = bindingCountryCode || countryCode || null;
        const sitelinks = Number.parseInt(readSparqlBinding(binding, "sitelinks") ?? "0", 10) || 0;
        const image = readSparqlBinding(binding, "image");

        seen.add(wikidataId);
        ranked.push({
            name,
            type: classifyPlaceTypeFromCategory(categoryLabel),
            distance: distanceMeters,
            city,
            countryCode: resolvedCountryCode,
            countryFlag:
                resolvedCountryCode != null && resolvedCountryCode !== ""
                    ? flagFromIsoCode(resolvedCountryCode)
                    : (countryFlag ?? flagFromIsoCode(countryCode ?? "")),
            image: image || null,
            wikipediaUrl: null,
            wikidataId,
            lat: placeLat,
            lng: placeLng,
            sitelinks,
        });
    }

    ranked.sort((a, b) => {
        const byLinks = (b.sitelinks ?? 0) - (a.sitelinks ?? 0);
        if (byLinks !== 0) return byLinks;
        return (a.distance ?? 0) - (b.distance ?? 0);
    });

    return ranked.slice(0, limit);
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
 * }} context
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const fetchWikidataNearbyPopularPlaces = async (
    lat,
    lng,
    { city, countryCode = null, countryFlag, limit = MAX_NEARBY_RESULTS },
    fetchImpl = fetch,
) => {
    const query = buildNearbyPopularPlacesSparql(lat, lng);
    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKIDATA_SPARQL_TIMEOUT_MS);
    try {
        logExternalApiRequestUrl(url.toString(), {
            extra: `wikidata-nearby lat=${lat} lng=${lng} radiusKm=${NEARBY_RADIUS_KM}`,
        });
        const response = await fetchImpl(url, {
            headers: WIKI_HEADERS,
            signal: controller.signal,
        });
        logExternalApiResponseUrl(url.toString(), response.status, {
            extra: `wikidata-nearby lat=${lat} lng=${lng}`,
        });
        if (!response.ok) {
            throw new Error(`Wikidata SPARQL HTTP ${response.status}`);
        }

        const body = /** @type {{ results?: { bindings?: Array<Record<string, unknown>> } }} */ (
            await response.json()
        );
        const bindings = Array.isArray(body?.results?.bindings) ? body.results.bindings : [];
        return mapWikidataBindingsToPlaces(bindings, {
            lat,
            lng,
            city,
            countryCode,
            countryFlag,
            limit,
        });
    } finally {
        clearTimeout(timer);
    }
};
