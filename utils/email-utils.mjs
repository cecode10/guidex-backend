/** Hidden copy for transactional mail (reports, account deletion, …). */
export const MAIL_SUPPORT_BCC = "info@kudosaitech.com";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalizeEmail = (value) => {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    return EMAIL_RE.test(email) ? email : null;
};

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export const asAddressList = (value) => {
    if (value == null) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw.map(normalizeEmail).filter((email) => email != null);
};

/**
 * @param {Record<string, unknown> | undefined | null} userData
 * @returns {string | null}
 */
export const emailFromUserDoc = (userData) => normalizeEmail(userData?.email);

/**
 * @param {string} value
 * @returns {string}
 */
export const escapeHtml = (value) =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
