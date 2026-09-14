import { MAIL_SUPPORT_BCC, emailFromUserDoc, normalizeEmail } from "./email-utils.mjs";
import { renderMailTemplate } from "./mail-template-utils.mjs";

export { MAIL_SUPPORT_BCC as SUPPORT_REPORT_BCC, emailFromUserDoc, normalizeEmail };

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
 * Content for {@link import("../services/mail-service.mjs").sendMail}.
 *
 * @param {{
 *   reporterEmail: string | null,
 *   reporterId: string,
 *   reportedUserId: string,
 *   reportedUsername: string,
 *   reason: string,
 *   reportId: string,
 * }} input
 */
export const buildReportReceivedMail = ({
    reporterEmail,
    reporterId,
    reportedUserId,
    reportedUsername,
    reason,
    reportId,
}) => {
    const accused = reportedUsername || reportedUserId || "another user";
    const { html, text } = renderMailTemplate("report-received", {
        reportId: reportId || "(unknown)",
        reporterId: reporterId || "(unknown)",
        reportedUser: reportedUserId ? `${accused} (${reportedUserId})` : accused,
        reason: reason || "(none provided)",
        title: "We received your report",
        footerNotice:
            "This is a service email sent because a user report was submitted from a Ramblex account associated with this address. It is not marketing communication.",
    });

    if (reporterEmail) {
        return {
            to: reporterEmail,
            bccSupport: true,
            subject: "We received your report",
            text,
            html,
        };
    }

    return {
        to: MAIL_SUPPORT_BCC,
        subject: "User report received (reporter has no email)",
        text,
        html,
    };
};
