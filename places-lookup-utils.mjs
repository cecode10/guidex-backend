import {
    logExternalApiRequestUrl,
    logExternalApiResponseUrl,
} from "./external-api-debug.mjs";
import { flagFromIsoCode } from "./geo-location-utils.mjs";

/** Whitelisted Wikidata `instance of` (P31) categories for Explore / check-in. */
export const SPARQL_POI_CATEGORIES = `
    wd:Q570116 wd:Q2319498 wd:Q4989906 wd:Q9259 wd:Q1081138 wd:Q839954 wd:Q109607
    wd:Q358 wd:Q35112127 wd:Q811165
    wd:Q907116 wd:Q916475 wd:Q10387684 wd:Q10387575 wd:Q121871437 wd:Q11691318
    wd:Q570600 wd:Q916333 wd:Q624232 wd:Q29048696
    wd:Q23413 wd:Q16560 wd:Q751876 wd:Q57831 wd:Q1785071 wd:Q57821 wd:Q879050 wd:Q3950
    wd:Q2977 wd:Q56242215 wd:Q16970 wd:Q32815 wd:Q34627 wd:Q44539 wd:Q267596 wd:Q1370598
    wd:Q163687 wd:Q120560 wd:Q133747929 wd:Q108325 wd:Q1128397 wd:Q44613 wd:Q160742 wd:Q3615570
    wd:Q12518 wd:Q5191724 wd:Q72926449 wd:Q797765
    wd:Q12280 wd:Q158438 wd:Q3397526 wd:Q82117 wd:Q39715 wd:Q483453 wd:Q811979
    wd:Q8502 wd:Q22698 wd:Q46169 wd:Q35509 wd:Q174782 wd:Q54114 wd:Q1107656
    wd:Q33506 wd:Q207694 wd:Q24354 wd:Q41253 wd:Q153562 wd:Q483110 wd:Q43501 wd:Q849706
    wd:Q194195
    wd:Q860861 wd:Q851563 wd:Q6017969 wd:Q15135589 wd:Q39614 wd:Q3918
`;

/** Normal-rank P31 values require `p:P31` / `ps:P31` instead of `wdt:P31`. */
export const SPARQL_INSTANCE_OF_CLAUSE = `
          ?item p:P31 ?p31Statement .
          ?p31Statement ps:P31 ?category .
`;

export const CONTAINER_WIKIDATA_TYPES = new Set([
    "Q515",
    "Q5119",
    "Q1549593",
    "Q1637706",
    "Q1093829",
    "Q486972",
    "Q3957",
    "Q532",
    "Q150241",
    "Q15284",
    "Q1048835",
    "Q6256",
    "Q3624078",
]);

export const NEARBY_RADIUS_KM = 3;
export const CHECKIN_NEARBY_DEFAULT_LIMIT = 50;
export const GLOBAL_SEARCH_SPARQL_LIMIT = 100;
export const GLOBAL_SEARCH_RESULT_LIMIT = 40;
export const WIKIDATA_SPARQL_TIMEOUT_MS = 20_000;
export const NOMINATIM_TIMEOUT_MS = 12_000;
export const WIKIDATA_API_TIMEOUT_MS = 30_000;

export const WIKI_SPARQL_HEADERS = {
    "User-Agent": "rambleX-mobile (https://ramblex.app)",
    Accept: "application/sparql-results+json",
};

export const WIKI_API_HEADERS = {
    "User-Agent": "rambleX-mobile (https://ramblex.app)",
    Accept: "application/json",
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

const LOCALITY_KEYS = [
    "city",
    "town",
    "village",
    "municipality",
    "borough",
    "city_district",
    "suburb",
    "district",
    "county",
    "state_district",
];

const LOCALITY_TYPES = new Set(["city", "town", "village", "municipality", "borough"]);

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
 * @param {number} lat
 * @param {number} lng
 * @param {{
 *   radiusKm?: number,
 *   limit?: number,
 *   offset?: number,
 *   orderBy?: "distance" | "popularity",
 *   fetchLimit?: number,
 * }} [options]
 * @returns {string}
 */
export const buildNearbyPlacesSparql = (
    lat,
    lng,
    {
        radiusKm = NEARBY_RADIUS_KM,
        limit = CHECKIN_NEARBY_DEFAULT_LIMIT,
        offset = 0,
        orderBy = "distance",
        fetchLimit,
    } = {},
) => {
    const effectiveLimit = fetchLimit ?? limit;
    const orderClause =
        orderBy === "popularity" ? "ORDER BY DESC(?sitelinks)" : "ORDER BY ?dist";
    const offsetClause = orderBy === "distance" && offset > 0 ? ` OFFSET ${offset}` : "";

    return `
SELECT ?item ?itemLabel ?itemDescription ?image ?location ?dist ?categoryLabel ?sitelinks ?countryLabel ?countryCode WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  VALUES ?category { ${SPARQL_POI_CATEGORIES} }
  ${SPARQL_INSTANCE_OF_CLAUSE}
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country wdt:P297 ?countryCode .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ?item wikibase:sitelinks ?sitelinks .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ${orderClause} LIMIT ${effectiveLimit}${offsetClause}
`.trim();
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @param {number} [limit]
 * @returns {string}
 */
export const buildGlobalAroundSparql = (lat, lng, radiusKm, limit = GLOBAL_SEARCH_SPARQL_LIMIT) => `
SELECT ?item ?itemLabel ?image ?location ?sitelinks ?countryLabel ?countryCode WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lng.toFixed(6)} ${lat.toFixed(6)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  VALUES ?category { ${SPARQL_POI_CATEGORIES} }
  ${SPARQL_INSTANCE_OF_CLAUSE}
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country wdt:P297 ?countryCode .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ?item wikibase:sitelinks ?sitelinks .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sitelinks) LIMIT ${limit}
`.trim();

/**
 * @param {string} qid
 * @returns {string}
 */
export const buildSingleEntitySparql = (qid) => `
SELECT ?item ?itemLabel ?image ?location ?sitelinks ?countryLabel ?countryCode WHERE {
  BIND(wd:${qid} AS ?item)
  ?item wdt:P625 ?location .
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country wdt:P297 ?countryCode .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ?item wikibase:sitelinks ?sitelinks .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 1
`.trim();

/**
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const runWikidataSparql = async (query, fetchImpl = fetch, { extra = "" } = {}) => {
    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKIDATA_SPARQL_TIMEOUT_MS);
    try {
        logExternalApiRequestUrl(url.toString(), { extra: extra || "wikidata-sparql" });
        const response = await fetchImpl(url, {
            headers: WIKI_SPARQL_HEADERS,
            signal: controller.signal,
        });
        logExternalApiResponseUrl(url.toString(), response.status, {
            extra: extra || "wikidata-sparql",
        });
        if (!response.ok) {
            throw new Error(`Wikidata SPARQL HTTP ${response.status}`);
        }
        const body = /** @type {{ results?: { bindings?: Array<Record<string, unknown>> } }} */ (
            await response.json()
        );
        return Array.isArray(body?.results?.bindings) ? body.results.bindings : [];
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {Record<string, unknown>} body
 * @param {Record<string, unknown>} address
 * @returns {string}
 */
export const cityFromNominatim = (body, address) => {
    for (const key of LOCALITY_KEYS) {
        const value = address?.[key];
        if (value != null) {
            const label = String(value).trim();
            if (label) return label;
        }
    }

    const addresstype = String(body?.addresstype ?? "");
    const name = String(body?.name ?? "").trim();
    if (LOCALITY_TYPES.has(addresstype) && name) return name;

    const displayName = String(body?.display_name ?? "").trim();
    if (displayName) {
        const first = displayName.split(",")[0]?.trim();
        if (first) return first;
    }

    return "Nearby";
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ city: string, country: string, countryCode: string | null, countryFlag: string }>}
 */
export const reverseGeocodeNominatim = async (lat, lng, fetchImpl = fetch) => {
    const url =
        `https://nominatim.openstreetmap.org/reverse?` +
        `format=json&lat=${lat}&lon=${lng}&zoom=10`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
    try {
        logExternalApiRequestUrl(url, { extra: `nominatim-reverse lat=${lat} lng=${lng}` });
        const response = await fetchImpl(url, {
            headers: {
                "User-Agent": "rambleX-mobile (https://ramblex.app)",
                "Accept-Language": "en",
            },
            signal: controller.signal,
        });
        logExternalApiResponseUrl(url, response.status, {
            extra: `nominatim-reverse lat=${lat} lng=${lng}`,
        });
        if (!response.ok) {
            return { city: "Nearby", country: "", countryCode: null, countryFlag: "📍" };
        }
        const body = /** @type {Record<string, unknown>} */ (await response.json());
        const address = /** @type {Record<string, unknown>} */ (body.address ?? {});
        const city = cityFromNominatim(body, address);
        const country = String(address.country ?? "");
        const countryCodeRaw = String(address.country_code ?? "").toUpperCase();
        const countryCode = countryCodeRaw || null;
        return {
            city,
            country,
            countryCode,
            countryFlag: flagFromIsoCode(countryCode ?? ""),
        };
    } catch {
        return { city: "Nearby", country: "", countryCode: null, countryFlag: "📍" };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {Array<Record<string, unknown>>} bindings
 * @param {{
 *   lat: number,
 *   lng: number,
 *   city: string,
 *   country?: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 *   defaultDistanceMeters?: number,
 * }} context
 * @returns {Array<Record<string, unknown>>}
 */
export const mapBindingsToPlaces = (
    bindings,
    {
        lat,
        lng,
        city,
        country = "",
        countryCode = null,
        countryFlag = "📍",
        defaultDistanceMeters = 0,
    },
) => {
    const seen = new Set();
    const out = [];

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
        const distKm = Number.parseFloat(readSparqlBinding(binding, "dist") ?? "0");
        const distanceMeters = Number.isFinite(distKm)
            ? Math.round(distKm * 1000)
            : defaultDistanceMeters;
        const categoryLabel = readSparqlBinding(binding, "categoryLabel") ?? "Point of Interest";
        const bindingCountryCode = (readSparqlBinding(binding, "countryCode") ?? "").toUpperCase();
        const resolvedCountryCode = bindingCountryCode || countryCode || null;
        const countryLabel = readSparqlBinding(binding, "countryLabel") ?? country;
        const sitelinks = Number.parseInt(readSparqlBinding(binding, "sitelinks") ?? "0", 10) || 0;

        seen.add(wikidataId);
        out.push({
            name,
            type: classifyPlaceTypeFromCategory(categoryLabel),
            distance: distanceMeters,
            city,
            country: countryLabel,
            countryCode: resolvedCountryCode,
            countryFlag:
                resolvedCountryCode != null && resolvedCountryCode !== ""
                    ? flagFromIsoCode(resolvedCountryCode)
                    : countryFlag,
            image: readSparqlBinding(binding, "image") || null,
            wikipediaUrl: null,
            wikidataId,
            lat: coords?.lat ?? lat,
            lng: coords?.lng ?? lng,
            sitelinks,
        });
    }

    return out;
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{
 *   limit?: number,
 *   offset?: number,
 *   city?: string,
 *   country?: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 * }} [options]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ places: Array<Record<string, unknown>>, hasMore: boolean }>}
 */
export const fetchNearbyPlacesPaginated = async (
    lat,
    lng,
    {
        limit = CHECKIN_NEARBY_DEFAULT_LIMIT,
        offset = 0,
        city,
        country = "",
        countryCode = null,
        countryFlag = "📍",
    } = {},
    fetchImpl = fetch,
) => {
    let geo = { city: city ?? "Nearby", country, countryCode, countryFlag };
    if (!city) {
        const reverse = await reverseGeocodeNominatim(lat, lng, fetchImpl);
        geo = reverse;
    }

    const query = buildNearbyPlacesSparql(lat, lng, {
        limit,
        offset,
        orderBy: "distance",
    });
    const bindings = await runWikidataSparql(query, fetchImpl);
    const places = mapBindingsToPlaces(bindings, {
        lat,
        lng,
        city: geo.city,
        country: geo.country,
        countryCode: geo.countryCode,
        countryFlag: geo.countryFlag,
    });

    return {
        places,
        hasMore: bindings.length >= limit,
    };
};

/**
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const searchWikidataEntities = async (query, fetchImpl = fetch) => {
    const trimmed = String(query || "").trim();
    if (!trimmed) return [];

    const url =
        "https://www.wikidata.org/w/api.php?action=wbsearchentities" +
        `&search=${encodeURIComponent(trimmed)}` +
        "&language=en&format=json&origin=*";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKIDATA_API_TIMEOUT_MS);
    try {
        logExternalApiRequestUrl(url, { extra: `wbsearchentities query="${trimmed}"` });
        const response = await fetchImpl(url, {
            headers: WIKI_API_HEADERS,
            signal: controller.signal,
        });
        logExternalApiResponseUrl(url, response.status, {
            extra: `wbsearchentities query="${trimmed}"`,
        });
        if (!response.ok) return [];
        const body = /** @type {{ search?: Array<Record<string, unknown>> }} */ (
            await response.json()
        );
        return Array.isArray(body.search) ? body.search : [];
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {string} qid
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export const fetchWikidataEntityClaims = async (qid, fetchImpl = fetch) => {
    const url =
        `https://www.wikidata.org/w/api.php?action=wbgetentities` +
        `&ids=${encodeURIComponent(qid)}&props=claims&format=json&origin=*`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKIDATA_API_TIMEOUT_MS);
    try {
        logExternalApiRequestUrl(url, { extra: `wbgetentities qid=${qid}` });
        const response = await fetchImpl(url, {
            headers: WIKI_API_HEADERS,
            signal: controller.signal,
        });
        logExternalApiResponseUrl(url, response.status, { extra: `wbgetentities qid=${qid}` });
        if (!response.ok) return null;
        const body = await response.json();
        return body?.entities?.[qid] ?? null;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {Record<string, unknown>} entity
 * @returns {{ lat: number | null, lng: number | null, instanceOf: Set<string> }}
 */
export const parseEntityCoordinatesAndTypes = (entity) => {
    const claims = /** @type {Record<string, unknown>} */ (entity?.claims ?? {});
    const p625 = /** @type {Array<Record<string, unknown>>} */ (claims.P625 ?? []);
    let lat = null;
    let lng = null;
    if (p625.length > 0) {
        const value = /** @type {{ latitude?: number, longitude?: number }} */ (
            p625[0]?.mainsnak?.datavalue?.value ?? null
        );
        if (value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
            lat = value.latitude;
            lng = value.longitude;
        }
    }

    const p31 = /** @type {Array<Record<string, unknown>>} */ (claims.P31 ?? []);
    const instanceOf = new Set(
        p31
            .map((claim) => String(claim?.mainsnak?.datavalue?.value?.id ?? "").trim())
            .filter(Boolean),
    );

    return { lat, lng, instanceOf };
};

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @param {{
 *   city: string,
 *   country?: string,
 *   countryCode?: string | null,
 *   countryFlag?: string,
 * }} geo
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const fetchGlobalAroundPlaces = async (
    lat,
    lng,
    radiusKm,
    geo,
    fetchImpl = fetch,
) => {
    const query = buildGlobalAroundSparql(lat, lng, radiusKm);
    const bindings = await runWikidataSparql(query, fetchImpl);
    const ranked = [...bindings].sort((a, b) => {
        const aLinks = Number.parseInt(readSparqlBinding(a, "sitelinks") ?? "0", 10) || 0;
        const bLinks = Number.parseInt(readSparqlBinding(b, "sitelinks") ?? "0", 10) || 0;
        return bLinks - aLinks;
    });
    return mapBindingsToPlaces(ranked.slice(0, GLOBAL_SEARCH_RESULT_LIMIT), {
        lat,
        lng,
        city: geo.city,
        country: geo.country ?? "",
        countryCode: geo.countryCode ?? null,
        countryFlag: geo.countryFlag ?? "📍",
        defaultDistanceMeters: 0,
    });
};

/**
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ places: Array<Record<string, unknown>>, lat: number | null, lng: number | null }>}
 */
export const fetchGlobalPlacesViaWikidataEntity = async (query, fetchImpl = fetch) => {
    const trimmed = String(query || "").trim();
    if (!trimmed) return { places: [], lat: null, lng: null };

    const results = await searchWikidataEntities(trimmed, fetchImpl);
    if (results.length === 0) return { places: [], lat: null, lng: null };

    const best = results[0];
    const qid = String(best?.id ?? "").trim();
    const bestLabel = String(best?.label ?? "").trim();
    if (!qid) return { places: [], lat: null, lng: null };

    const entity = await fetchWikidataEntityClaims(qid, fetchImpl);
    if (!entity) return { places: [], lat: null, lng: null };

    const { lat, lng, instanceOf } = parseEntityCoordinatesAndTypes(entity);
    const isContainer = [...instanceOf].some((type) => CONTAINER_WIKIDATA_TYPES.has(type));

    let bindings;
    if (lat != null && lng != null) {
        const radius = isContainer ? 10 : 2;
        const sparql = buildGlobalAroundSparql(lat, lng, radius);
        bindings = await runWikidataSparql(sparql, fetchImpl);
    } else {
        bindings = await runWikidataSparql(buildSingleEntitySparql(qid), fetchImpl);
    }

    let geo;
    if (isContainer) {
        geo = { city: bestLabel || trimmed, country: "", countryCode: null, countryFlag: "📍" };
    } else if (lat != null && lng != null) {
        geo = await reverseGeocodeNominatim(lat, lng, fetchImpl);
    } else {
        geo = { city: "Nearby", country: "", countryCode: null, countryFlag: "📍" };
    }

    const ranked = [...bindings].sort((a, b) => {
        const aLinks = Number.parseInt(readSparqlBinding(a, "sitelinks") ?? "0", 10) || 0;
        const bLinks = Number.parseInt(readSparqlBinding(b, "sitelinks") ?? "0", 10) || 0;
        return bLinks - aLinks;
    });

    const places = mapBindingsToPlaces(ranked.slice(0, GLOBAL_SEARCH_RESULT_LIMIT), {
        lat: lat ?? 0,
        lng: lng ?? 0,
        city: geo.city,
        country: geo.country ?? "",
        countryCode: geo.countryCode ?? null,
        countryFlag: geo.countryFlag ?? "📍",
        defaultDistanceMeters: 0,
    });

    return { places, lat, lng };
};

/**
 * Runs geocode-anchor search, then Wikidata entity fallback when needed.
 *
 * @param {string} query
 * @param {{
 *   resolveGeocodeAnchor: (query: string) => Promise<{
 *     lat?: number,
 *     lng?: number,
 *     label?: string,
 *     radiusKm?: number,
 *   } | null>,
 * }} deps
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ places: Array<Record<string, unknown>>, lat: number | null, lng: number | null }>}
 */
export const fetchGlobalPlacesSearch = async (query, { resolveGeocodeAnchor }, fetchImpl = fetch) => {
    const trimmed = String(query || "").trim();
    if (!trimmed) return { places: [], lat: null, lng: null };

    const anchor = await resolveGeocodeAnchor(trimmed);
    if (anchor?.lat != null && anchor?.lng != null) {
        const cityFromLabel = String(anchor.label ?? "")
            .split(",")[0]
            ?.trim();
        const geo = await reverseGeocodeNominatim(anchor.lat, anchor.lng, fetchImpl);
        const searchGeo = {
            city: cityFromLabel || geo.city,
            country: geo.country,
            countryCode: geo.countryCode,
            countryFlag: geo.countryFlag,
        };
        const places = await fetchGlobalAroundPlaces(
            anchor.lat,
            anchor.lng,
            anchor.radiusKm ?? 2,
            searchGeo,
            fetchImpl,
        );
        if (places.length > 0) {
            return { places, lat: anchor.lat, lng: anchor.lng };
        }
    }

    return fetchGlobalPlacesViaWikidataEntity(trimmed, fetchImpl);
};
