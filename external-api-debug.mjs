/**
 * Debug logging for third-party geo / encyclopedia APIs.
 * Strips secrets (API keys) from logged URLs.
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
        if (host.includes("wikidata.org")) return "wikidata";
        if (host.includes("wikipedia.org")) return "wikipedia";
        if (host.includes("wikimedia.org")) return "wikimedia";
    } catch {
        /* ignore */
    }
    return null;
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
