import {
    logExternalApiRequestUrl,
    logExternalApiResponseUrl,
} from "./external-api-debug.mjs";
import { flagFromIsoCode } from "./geo-location-utils.mjs";

/** Whitelisted Wikidata `instance of` (P31) categories for Explore / check-in. */
export const SPARQL_POI_CATEGORIES = `
    wd:Q570116 wd:Q2319498 wd:Q4989906 wd:Q9259 wd:Q1081138 wd:Q839954 wd:Q109607
    wd:Q35112127 wd:Q811165
    wd:Q907116 wd:Q916475 wd:Q10387684 wd:Q10387575 wd:Q121871437 wd:Q11691318
    wd:Q570600 wd:Q916333 wd:Q624232 wd:Q29048696
    wd:Q23413 wd:Q16560 wd:Q751876 wd:Q57831 wd:Q1785071 wd:Q57821 wd:Q879050 wd:Q3950
    wd:Q2977 wd:Q56242215 wd:Q16970 wd:Q32815 wd:Q34627 wd:Q44539 wd:Q267596 wd:Q1370598
    wd:Q163687 wd:Q120560 wd:Q133747929 wd:Q108325 wd:Q1128397 wd:Q44613 wd:Q160742 wd:Q1864226
    wd:Q5191724 wd:Q72926449 wd:Q797765
    wd:Q82117 wd:Q39715 wd:Q483453
    wd:Q22698 wd:Q46169 wd:Q35509 wd:Q1107656
    wd:Q33506 wd:Q207694 wd:Q153562 wd:Q43501
    wd:Q194195
    wd:Q860861 wd:Q5003624 wd:Q6017969 wd:Q15135589
`;

/** Normal-rank P31 values require `p:P31` / `ps:P31` instead of `wdt:P31`. */
export const SPARQL_INSTANCE_OF_CLAUSE = `
          ?item p:P31 ?p31Statement .
          ?p31Statement ps:P31 ?category .
`;

/**
 * Non-POI `instance of` roots excluded from fast Explore search SPARQL.
 * Uses `wdt:P31/wdt:P279*` so cities, countries, languages, people, events,
 * and transport infrastructure are dropped without the expensive VALUES category join.
 */
export const SPARQL_EXCLUDED_INSTANCE_ROOTS = `
    wd:Q515 wd:Q5119 wd:Q1549593 wd:Q1637706 wd:Q1093829 wd:Q486972 wd:Q3957
    wd:Q532 wd:Q150241 wd:Q15284 wd:Q1048835 wd:Q6256 wd:Q3624078
    wd:Q347 wd:Q33742 wd:Q1288568 wd:Q17376908 wd:Q3331189
    wd:Q5 wd:Q43229 wd:Q1656682 wd:Q1190554 wd:Q198 wd:Q27020041
    wd:Q928830 wd:Q55488 wd:Q55491 wd:Q953806 wd:Q1248784 wd:Q644371 wd:Q849706
`;

export const NEARBY_RADIUS_KM = 3;
export const CHECKIN_NEARBY_DEFAULT_LIMIT = 50;
/** Default Wikidata SPARQL timeout for nearby (3 km) Explore queries. */
export const WIKIDATA_SPARQL_TIMEOUT_MS = 20_000;
/** Longer timeout for wider global-search radii (e.g. 10 km cities). */
export const WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS = 45_000;
export const WIKIDATA_SPARQL_MAX_ATTEMPTS = 2;
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

/** Final row cap for Explore text search (we only show 30). */
export const EXPLORE_SEARCH_SPARQL_FETCH_LIMIT = 40;
/** Minimum sitelinks for POI anchors (3 km). */
export const EXPLORE_SEARCH_POI_MIN_SITELINKS = 10;
/** Minimum sitelinks for wider city searches (10 km). */
export const EXPLORE_SEARCH_CITY_MIN_SITELINKS = 15;

/**
 * @param {number} radiusKm
 * @returns {number}
 */
export const exploreSearchMinSitelinksForRadius = (radiusKm) =>
    Number(radiusKm) <= NEARBY_RADIUS_KM
        ? EXPLORE_SEARCH_POI_MIN_SITELINKS
        : EXPLORE_SEARCH_CITY_MIN_SITELINKS;

/**
 * Fast Explore text-search SPARQL. Skips the expensive VALUES + `p:P31` join
 * (that join alone takes 40–50 s in dense cities). Keeps notable POIs via
 * sitelinks rank and excludes cities, countries, languages, people, and events.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @param {{
 *   fetchLimit?: number,
 *   minSitelinks?: number,
 * }} [options]
 * @returns {string}
 */
export const buildExplorePopularPlacesSparql = (
    lat,
    lng,
    radiusKm,
    {
        fetchLimit = EXPLORE_SEARCH_SPARQL_FETCH_LIMIT,
        minSitelinks = exploreSearchMinSitelinksForRadius(radiusKm),
    } = {},
) => `
SELECT ?item ?itemLabel ?image ?location ?dist ?sitelinks WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks})
  FILTER NOT EXISTS {
    ?item wdt:P31/wdt:P279* ?excluded .
    VALUES ?excluded { ${SPARQL_EXCLUDED_INSTANCE_ROOTS} }
  }
  OPTIONAL { ?item wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks)
LIMIT ${fetchLimit}
`.trim();

/**
 * Raised when Wikidata SPARQL fails transiently (timeout / abort) after retries.
 */
export class WikidataSparqlTransientError extends Error {
    /**
     * @param {string} message
     * @param {{ extra?: string, attempts?: number, timeoutMs?: number }} [options]
     */
    constructor(message, { extra = "", attempts = 1, timeoutMs = 0 } = {}) {
        super(message);
        this.name = "WikidataSparqlTransientError";
        this.statusCode = 504;
        this.extra = extra;
        this.attempts = attempts;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export const isWikidataSparqlAbortError = (error) => {
    if (error?.name === "AbortError") return true;
    const message = String(error?.message ?? "").toLowerCase();
    return message.includes("aborted") || message.includes("abort");
};

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export const isRetryableWikidataSparqlError = (error) => {
    if (isWikidataSparqlAbortError(error)) return true;
    const message = String(error?.message ?? "");
    return /^Wikidata SPARQL HTTP (429|5\d\d)$/.test(message);
};

/**
 * @param {number} radiusKm
 * @returns {number}
 */
export const sparqlTimeoutMsForRadius = (radiusKm) =>
    Number(radiusKm) > NEARBY_RADIUS_KM
        ? WIKIDATA_SPARQL_SEARCH_TIMEOUT_MS
        : WIKIDATA_SPARQL_TIMEOUT_MS;

const sparqlRetryBackoffMs = (attemptIndex) => 400 * 2 ** attemptIndex;

/**
 * @param {string} query
 * @param {typeof fetch} fetchImpl
 * @param {{ extra?: string, timeoutMs?: number, attempt?: number }} options
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
const runWikidataSparqlOnce = async (
    query,
    fetchImpl,
    { extra = "", timeoutMs = WIKIDATA_SPARQL_TIMEOUT_MS, attempt = 0 } = {},
) => {
    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const attemptLabel = attempt > 0 ? ` attempt=${attempt + 1}` : "";
    try {
        logExternalApiRequestUrl(url.toString(), {
            extra: `${extra || "wikidata-sparql"}${attemptLabel} timeoutMs=${timeoutMs}`,
        });
        const response = await fetchImpl(url, {
            headers: WIKI_SPARQL_HEADERS,
            signal: controller.signal,
        });
        logExternalApiResponseUrl(url.toString(), response.status, {
            extra: `${extra || "wikidata-sparql"}${attemptLabel}`,
        });
        if (!response.ok) {
            throw new Error(`Wikidata SPARQL HTTP ${response.status}`);
        }
        const body = /** @type {{ results?: { bindings?: Array<Record<string, unknown>> } }} */ (
            await response.json()
        );
        return Array.isArray(body?.results?.bindings) ? body.results.bindings : [];
    } catch (error) {
        if (isWikidataSparqlAbortError(error)) {
            console.warn(
                `[wikidata-sparql] timeout after ${timeoutMs}ms${attemptLabel}` +
                    (extra ? `: ${extra}` : ""),
            );
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 * @param {{
 *   extra?: string,
 *   timeoutMs?: number,
 *   maxAttempts?: number,
 * }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export const runWikidataSparql = async (
    query,
    fetchImpl = fetch,
    {
        extra = "",
        timeoutMs = WIKIDATA_SPARQL_TIMEOUT_MS,
        maxAttempts = WIKIDATA_SPARQL_MAX_ATTEMPTS,
    } = {},
) => {
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            const delayMs = sparqlRetryBackoffMs(attempt - 1);
            console.warn(
                `[wikidata-sparql] retrying in ${delayMs}ms` +
                    (extra ? ` (${extra})` : "") +
                    ` after: ${lastError?.message || lastError}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        try {
            return await runWikidataSparqlOnce(query, fetchImpl, {
                extra,
                timeoutMs,
                attempt,
            });
        } catch (error) {
            lastError = error;
            if (!isRetryableWikidataSparqlError(error) || attempt >= maxAttempts - 1) {
                break;
            }
        }
    }

    console.error(
        `[wikidata-sparql] exhausted ${maxAttempts} attempt(s) ` +
            `(timeoutMs=${timeoutMs})` +
            (extra ? `: ${extra}` : "") +
            ` — ${lastError?.message || lastError}`,
    );
    throw new WikidataSparqlTransientError(
        lastError?.message || "Wikidata SPARQL timed out",
        { extra, attempts: maxAttempts, timeoutMs },
    );
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
        radiusKm = NEARBY_RADIUS_KM,
    } = {},
    fetchImpl = fetch,
) => {
    let geo = { city: city ?? "Nearby", country, countryCode, countryFlag };
    if (!city) {
        const reverse = await reverseGeocodeNominatim(lat, lng, fetchImpl);
        geo = reverse;
    }

    const { findNearbySightseeing } = await import("./sightseeing-query.mjs");
    return findNearbySightseeing(lat, lng, {
        radiusKm,
        limit,
        offset,
        orderBy: "distance",
        city: geo.city,
        country: geo.country,
        countryCode: geo.countryCode,
        countryFlag: geo.countryFlag,
    });
};
