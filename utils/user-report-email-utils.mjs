export const SUPPORT_REPORT_BCC = "support@kudosaitech.com";
export const MAIL_COLLECTION = "mail";

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
 * @param {Record<string, unknown> | undefined | null} userData
 * @returns {string | null}
 */
export const emailFromUserDoc = (userData) => normalizeEmail(userData?.email);

/**
 * @param {Record<string, unknown> | undefined | null} reportData
 * @returns {{
 *   reporterId: string,
 *   reportedUserId: string,
 *   reportedUsername: string,
 *   reason: string,
 *   reporterEmail: string | null,
 * }}
 */
export const reportFieldsFromDoc = (reportData) => {
    const reporterId = typeof reportData?.reporterId === "string"
        ? reportData.reporterId.trim()
        : "";
    const reportedUserId = typeof reportData?.reportedUserId === "string"
        ? reportData.reportedUserId.trim()
        : "";
    const reportedUsername = typeof reportData?.reportedUsername === "string"
        ? reportData.reportedUsername.trim()
        : "";
    const reason = typeof reportData?.reason === "string"
        ? reportData.reason.trim()
        : "";
    return {
        reporterId,
        reportedUserId,
        reportedUsername,
        reason,
        reporterEmail: normalizeEmail(reportData?.reporterEmail),
    };
};

/**
 * Firestore `mail` document for the Trigger Email extension.
 *
 * @param {{
 *   reporterEmail: string | null,
 *   reporterId: string,
 *   reportedUserId: string,
 *   reportedUsername: string,
 *   reason: string,
 *   reportId: string,
 * }} input
 * @returns {Record<string, unknown>}
 */
export const buildReportReceivedMailDoc = ({
    reporterEmail,
    reporterId,
    reportedUserId,
    reportedUsername,
    reason,
    reportId,
}) => {
    const accused = reportedUsername || reportedUserId || "another user";
    const details = [
        `Report ID: ${reportId || "(unknown)"}`,
        `Reporting user: ${reporterId || "(unknown)"}`,
        `Reported user: ${accused}${reportedUserId ? ` (${reportedUserId})` : ""}`,
        "",
        "Reason:",
        reason || "(none provided)",
    ].join("\n");

    const text = [
        "Thanks for letting us know.",
        "",
        "We've received your report and our team will review it. You don't need to do anything else for now.",
        "",
        details,
        "",
        "This is an automated message from Ramblex.",
    ].join("\n");

    const html = [
        "<p>Thanks for letting us know.</p>",
        "<p>We've received your report and our team will review it. You don't need to do anything else for now.</p>",
        `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(details)}</pre>`,
        "<p>This is an automated message from Ramblex.</p>",
    ].join("");

    if (reporterEmail) {
        return {
            to: [reporterEmail],
            bcc: [SUPPORT_REPORT_BCC],
            replyTo: SUPPORT_REPORT_BCC,
            message: {
                subject: "We received your report",
                text,
                html,
            },
        };
    }

    return {
        to: [SUPPORT_REPORT_BCC],
        replyTo: SUPPORT_REPORT_BCC,
        message: {
            subject: "User report received (reporter has no email)",
            text,
            html,
        },
    };
};

/**
 * @param {string} reportId
 * @returns {string}
 */
export const mailDocIdForReport = (reportId) => `user-report-${reportId}`;

/**
 * @param {string} value
 * @returns {string}
 */
const escapeHtml = (value) =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
