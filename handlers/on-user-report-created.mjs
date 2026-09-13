import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { sendMail } from "../services/mail-service.mjs";
import { mailFunctionSecrets } from "../utils/mail-params.mjs";
import {
    buildReportReceivedMail,
    emailFromUserDoc,
    reportFieldsFromDoc,
} from "../utils/user-report-email-utils.mjs";

/**
 * Sends a confirmation email when a user report is filed.
 * The reporter is the visible recipient; support is BCC'd via sendMail.
 */
export const onUserReportCreated = onDocumentCreated(
    {
        document: "user-reports/{reportId}",
        region: "europe-west3",
        secrets: mailFunctionSecrets,
    },
    async (event) => {
        const { reportId } = event.params;
        const reportData = event.data?.data();
        if (!reportData) return null;

        const fields = reportFieldsFromDoc(reportData);
        const db = getFirestore();

        let reporterEmail = fields.reporterEmail;
        if (!reporterEmail && fields.reporterId) {
            const reporterDoc = await db.collection("users").doc(fields.reporterId).get();
            reporterEmail = emailFromUserDoc(reporterDoc.data());
        }

        const result = await sendMail(buildReportReceivedMail({
            ...fields,
            reporterEmail,
            reportId,
        }));
        if (!result.ok) {
            console.error(
                "onUserReportCreated: send failed reportId=%s error=%s",
                reportId,
                result.error,
            );
            return null;
        }

        console.log(
            "onUserReportCreated: reportId=%s reporterId=%s reportedUserId=%s mailedTo=%s messageId=%s",
            reportId,
            fields.reporterId || "(none)",
            fields.reportedUserId || "(none)",
            reporterEmail || "(support-only)",
            result.messageId || "(none)",
        );
        return null;
    },
);
