/**
 * Debug logging for third-party geo / encyclopedia APIs.
 * Strips secrets (API keys) from logged URLs and prints decoded
 * Wikidata SPARQL / MediaWiki API parameters for investigation.
 */

/**
 * @param {string} url
 * @returns {string}
 */
export const sanitizeUrlForLog = (url) => {
    try {
        const parsed = new URL(String(url));
        parsed.searchParams.delete("key");
        parsed.searchParams.delete("username");
        return parsed.toString();
    } catch {
        return String(url);
    }
};

/**
 * @param {string} url
 * @returns {string | null}
 */
export const providerFromUrl = (url) => {
    try {
        const host = new URL(String(url)).hostname.toLowerCase();
        if (host.includes("googleapis.com")) return "google-geocoding";
        if (host.includes("openstreetmap.org")) return "nominatim";
        if (host.includes("wikidata.org")) return "wikidata";
        if (host.includes("wikipedia.org")) return "wikipedia";
        if (host.includes("wikimedia.org")) return "wikimedia";
    } catch {
        /* ignore */
    }
    return null;
};

/**
 * @param {string} url
 * @returns {Record<string, string> | null}
 */
export const mediaWikiApiParamsFromUrl = (url) => {
    try {
        const parsed = new URL(String(url));
        if (!parsed.pathname.endsWith("/w/api.php")) return null;
        const params = Object.fromEntries(parsed.searchParams.entries());
        delete params.origin;
        return params;
    } catch {
        return null;
    }
};

/**
 * @param {string} url
 * @returns {string | null}
 */
export const wikipediaRestPathFromUrl = (url) => {
    try {
        const parsed = new URL(String(url));
        const marker = "/api/rest_v1/";
        const idx = parsed.pathname.indexOf(marker);
        if (idx === -1) return null;
        return decodeURIComponent(parsed.pathname.slice(idx + marker.length));
    } catch {
        return null;
    }
};

/**
 * @param {string} url
 * @returns {string | null}
 */
export const sparqlQueryFromUrl = (url) => {
    try {
        const parsed = new URL(String(url));
        const query = parsed.searchParams.get("query");
        return query ? query.trim() : null;
    } catch {
        return null;
    }
};

/**
 * @param {string} provider
 * @param {string} url
 */
export const logExternalApiQueryDetails = (provider, url) => {
    const sparql = sparqlQueryFromUrl(url);
    if (sparql) {
        console.log(`[external-api] ${provider} sparql query:\n${sparql}`);
    }

    const apiParams = mediaWikiApiParamsFromUrl(url);
    if (apiParams && Object.keys(apiParams).length > 0) {
        console.log(
            `[external-api] ${provider} api params: ${JSON.stringify(apiParams)}`,
        );
    }

    const restPath = wikipediaRestPathFromUrl(url);
    if (restPath) {
        console.log(`[external-api] wikipedia rest path: ${restPath}`);
    }
};

/**
 * @param {string} cacheName
 * @param {{
 *   key?: string,
 *   detail?: string,
 *   skippedProviders?: string[],
 * }} [opts]
 * @returns {string}
 */
export const formatExternalApiCacheHit = (
    cacheName,
    { key = "", detail = "", skippedProviders = [] } = {},
) => {
    const skipped =
        skippedProviders.length > 0
            ? skippedProviders.join(", ")
            : "wikidata, wikipedia, wikimedia";
    const keyPart = key ? ` key=${key}` : "";
    const detailPart = detail ? ` ${detail}` : "";
    return `[external-api] cache hit cache=${cacheName}${keyPart} skipped=[${skipped}]${detailPart}`;
};

/**
 * Logs when a cached value is reused and upstream Wikidata/Wikipedia calls are skipped.
 *
 * @param {string} cacheName
 * @param {{
 *   key?: string,
 *   detail?: string,
 *   skippedProviders?: string[],
 * }} [opts]
 */
export const logExternalApiCacheHit = (cacheName, opts = {}) => {
    console.log(formatExternalApiCacheHit(cacheName, opts));
};

/**
 * @param {string} provider
 * @param {string} detail
 */
export const logExternalApiRequest = (provider, detail) => {
    console.log(`[external-api] ${provider} request ${detail}`);
};

/**
 * @param {string} provider
 * @param {string} detail
 */
export const logExternalApiResponse = (provider, detail) => {
    console.log(`[external-api] ${provider} response ${detail}`);
};

/**
 * @param {string} url
 * @param {{ extra?: string, attempt?: number }} [opts]
 */
export const logExternalApiRequestUrl = (url, { extra = "", attempt = 0 } = {}) => {
    const provider = providerFromUrl(url);
    if (!provider) return;
    const retry = attempt > 0 ? ` retry=${attempt}` : "";
    const suffix = extra ? ` ${extra}${retry}` : retry;
    logExternalApiRequest(provider, `GET ${sanitizeUrlForLog(url)}${suffix}`);
    logExternalApiQueryDetails(provider, url);
};

/**
 * @param {string} url
 * @param {number} status
 * @param {{ extra?: string }} [opts]
 */
export const logExternalApiResponseUrl = (url, status, { extra = "" } = {}) => {
    const provider = providerFromUrl(url);
    if (!provider) return;
    const suffix = extra ? ` ${extra}` : "";
    logExternalApiResponse(provider, `HTTP ${status}${suffix}`);
};

/**
 * Logs a Wikidata SPARQL query before it is sent (when built separately from the URL).
 *
 * @param {string} query
 * @param {{ extra?: string }} [opts]
 */
export const logWikidataSparqlQuery = (query, { extra = "" } = {}) => {
    const normalized = String(query || "").trim();
    if (!normalized) return;
    const suffix = extra ? ` ${extra}` : "";
    console.log(`[external-api] wikidata sparql request${suffix}`);
    console.log(`[external-api] wikidata sparql query:\n${normalized}`);
};
