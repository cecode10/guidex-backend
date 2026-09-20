export const CURRENT_TERMS_VERSION = "2026-09-20";
export const TERMS_URL = "https://kudosaitech.com/#terms";
export const PRIVACY_URL = "https://kudosaitech.com/#privacy";

const ALLOWED_PLATFORMS = new Set(["ios", "android", "web"]);

/**
 * First public IP from typical reverse-proxy headers, then the socket address.
 * @param {{ headers?: Record<string, string | string[] | undefined>, ip?: string, socket?: { remoteAddress?: string } }} req
 * @returns {string | null}
 */
export const clientIpFromRequest = (req) => {
    const forwarded = headerValue(req, "x-forwarded-for");
    if (forwarded) {
        const first = forwarded.split(",")[0].trim();
        if (first) return first;
    }
    const realIp = headerValue(req, "x-real-ip");
    if (realIp) return realIp;
    if (typeof req?.ip === "string" && req.ip.trim()) return req.ip.trim();
    const remote = req?.socket?.remoteAddress;
    if (typeof remote === "string" && remote.trim()) return remote.trim();
    return null;
};

/**
 * @param {unknown} data
 * @returns {boolean}
 */
export const isTermsAlreadyAccepted = (data) => {
    const acceptance = data?.termsAcceptance;
    return Boolean(acceptance && typeof acceptance === "object" && acceptance.acceptedAt);
};

/**
 * Profile-visible record. No IP — other signed-in users can read `users/{uid}`.
 * @param {{ acceptedAt: unknown }} args
 */
export const publicTermsAcceptance = ({ acceptedAt }) => ({
    acceptedAt,
    version: CURRENT_TERMS_VERSION,
    url: TERMS_URL,
});

/**
 * Support-only audit record, including IP. Stored under `users/{uid}/legal`.
 * @param {{
 *   acceptedAt: unknown,
 *   ipAddress?: string | null,
 *   userAgent?: string | null,
 *   locale?: string | null,
 *   platform?: string | null,
 * }} args
 */
export const legalTermsAcceptance = ({
    acceptedAt,
    ipAddress = null,
    userAgent = null,
    locale = null,
    platform = null,
}) => ({
    acceptedAt,
    version: CURRENT_TERMS_VERSION,
    url: TERMS_URL,
    privacyUrl: PRIVACY_URL,
    ipAddress: ipAddress || null,
    userAgent: optionalString(userAgent, 512),
    locale: optionalString(locale, 64),
    platform: normalizePlatform(platform),
    method: "explicit_accept_button",
});

/**
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string | null}
 */
export const optionalString = (value, maxLen = 64) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLen);
};

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalizePlatform = (value) => {
    const platform = optionalString(value, 16)?.toLowerCase();
    if (!platform || !ALLOWED_PLATFORMS.has(platform)) return null;
    return platform;
};

/**
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req
 * @param {string} name
 * @returns {string | null}
 */
const headerValue = (req, name) => {
    const headers = req?.headers;
    if (!headers || typeof headers !== "object") return null;
    const raw = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(raw)) {
        const first = raw.find((item) => typeof item === "string" && item.trim());
        return first ? String(first).trim() : null;
    }
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return null;
};
