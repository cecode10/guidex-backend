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
            ? "We received your report"
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
    return {
        reporterId,
        reportedUserId,
        reportedUsername,
        category,
        reason,
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

/**
 * Content for {@link import("../services/mail-service.mjs").sendMail}.
 *
 * @param {{
 *   reporterEmail: string | null,
 *   reporterId: string,
 *   reportedUserId: string,
 *   reportedUsername: string,
 *   category?: string,
 *   reason: string,
 *   reportId: string,
 * }} input
 */
export const buildReportReceivedMail = ({
    reporterEmail,
    reporterId,
    reportedUserId,
    reportedUsername,
    category = "",
    reason,
    reportId,
}) => {
    const accused = reportedUsername || reportedUserId || "(not specified)";
    const categoryLabel = reportCategoryLabel(category) || "(none provided)";
    const { html, text } = renderMailTemplate("report-received", {
        reportId: reportId || "(unknown)",
        reporterId: reporterId || "(unknown)",
        reportedUser: reportedUserId ? `${accused} (${reportedUserId})` : accused,
        categoryLabel,
        reason: formatReportReasonBody(category, reason),
        title: "We received your report",
        signoff: 'Your Kudosai team',
        footerNotice:
            "This is a service email sent because a user report was submitted from a Ramblex account associated with this address. It is not marketing communication.",
    });

    const subject = reportMailSubject({ category, reporterEmail });

    if (reporterEmail) {
        return {
            to: reporterEmail,
            bccSupport: true,
            subject,
            text,
            html,
        };
    }

    return {
        to: MAIL_SUPPORT_BCC,
        subject,
        text,
        html,
    };
};
