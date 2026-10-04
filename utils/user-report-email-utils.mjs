import { MAIL_SUPPORT_BCC, emailFromUserDoc, normalizeEmail } from "./email-utils.mjs";
import { renderMailTemplate } from "./mail-template-utils.mjs";

export { MAIL_SUPPORT_BCC as SUPPORT_REPORT_BCC, emailFromUserDoc, normalizeEmail };

export const REPORT_CATEGORY_LABELS = Object.freeze({
    csam: "Child sexual exploitation or CSAM",
    inappropriate: "Inappropriate content",
    harassment: "Harassment / hate",
    other: "Something else",
});

export const CSAM_SUBJECT_PREFIX = "<IMPORTANT>";

/**
 * @param {string} category
 * @returns {string | null}
 */
export const reportCategoryLabel = (category) => {
    if (typeof category !== "string") return null;
    const label = REPORT_CATEGORY_LABELS[category.trim()];
    return typeof label === "string" ? label : null;
};

/**
 * @param {{ category?: string | null, reporterEmail?: string | null }} input
 * @returns {string}
 */
export const reportMailSubject = ({ category, reporterEmail } = {}) => {
    const label = reportCategoryLabel(category ?? "");
    const important = category === "csam" ? `${CSAM_SUBJECT_PREFIX} ` : "";
    if (!label) {
        return reporterEmail
            ? "User report received"
            : "User report received (reporter has no email)";
    }
    const suffix = reporterEmail ? "" : " (reporter has no email)";
    return `${important}${label}${suffix}`;
};

/**
 * @param {Record<string, unknown> | undefined | null} reportData
 * @returns {{
 *   reporterId: string,
 *   reportedUserId: string,
 *   reportedUsername: string,
 *   category: string,
 *   reason: string,
 *   postId: string,
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
    const category = typeof reportData?.category === "string"
        ? reportData.category.trim()
        : "";
    const reason = typeof reportData?.reason === "string"
        ? reportData.reason.trim()
        : "";
    const postId = typeof reportData?.postId === "string"
        ? reportData.postId.trim()
        : "";
    return {
        reporterId,
        reportedUserId,
        reportedUsername,
        category,
        reason,
        postId,
        reporterEmail: normalizeEmail(reportData?.reporterEmail),
    };
};

/**
 * @param {string} category
 * @param {string} reason
 * @returns {string}
 */
export const formatReportReasonBody = (category, reason) => {
    const label = reportCategoryLabel(category);
    const details = typeof reason === "string" ? reason.trim() : "";
    if (label && details && details !== label) {
        return `${label}\n\n${details}`;
    }
    return details || label || "(none provided)";
};

export const REPORTER_MAIL_SUBJECT = "We received your report";

/**
 * Confirmation of receipt for the reporter. Carries only the report reference;
 * user and post identifiers stay in {@link buildReportSupportMail}.
 *
 * @param {{ reporterEmail: string, reportId: string }} input
 */
export const buildReportReceivedMail = ({ reporterEmail, reportId }) => {
    const { html, text } = renderMailTemplate("report-received", {
        reportId: reportId || "(unknown)",
        title: REPORTER_MAIL_SUBJECT,
        signoff: 'Your Kudosai team',
        footerNotice:
            "This is a service email sent because a user report was submitted from a Ramblex account associated with this address. It is not marketing communication.",
    });

    return {
        to: reporterEmail,
        subject: REPORTER_MAIL_SUBJECT,
        text,
        html,
    };
};

/**
 * Full report details for support.
 *
 * @param {{
 *   reporterEmail: string | null,
 *   reporterId: string,
 *   reportedUserId: string,
 *   reportedUsername: string,
 *   category?: string,
 *   reason: string,
 *   postId?: string,
 *   reportId: string,
 * }} input
 */
export const buildReportSupportMail = ({
    reporterEmail,
    reporterId,
    reportedUserId,
    reportedUsername,
    category = "",
    reason,
    postId = "",
    reportId,
}) => {
    const accused = reportedUsername || reportedUserId || "(not specified)";
    const categoryLabel = reportCategoryLabel(category) || "(none provided)";
    const { html, text } = renderMailTemplate("report-support", {
        reportId: reportId || "(unknown)",
        reporterId: reporterId || "(unknown)",
        reporterEmail: reporterEmail || "(none)",
        reportedUser: reportedUserId ? `${accused} (${reportedUserId})` : accused,
        postId: postId || "(none)",
        categoryLabel,
        reason: formatReportReasonBody(category, reason),
        title: "New user report",
        signoff: 'Ramblex reports',
        footerNotice: "Internal moderation notification. Do not forward to the reporter or the reported user.",
    });

    return {
        to: MAIL_SUPPORT_BCC,
        subject: reportMailSubject({ category, reporterEmail }),
        text,
        html,
    };
};
