import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import {
    MAIL_COLLECTION,
    buildReportReceivedMailDoc,
    emailFromUserDoc,
    mailDocIdForReport,
    reportFieldsFromDoc,
} from "../utils/user-report-email-utils.mjs";

/**
 * Queues a confirmation email via firestore-send-email when a user report
 * is filed. The reporter is the visible recipient; support is BCC'd.
 */
export const onUserReportCreated = onDocumentCreated(
    {
        document: "user-reports/{reportId}",
        region: "europe-west3",
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

        const mailDoc = buildReportReceivedMailDoc({
            ...fields,
            reporterEmail,
            reportId,
        });
        await db.collection(MAIL_COLLECTION).doc(mailDocIdForReport(reportId)).set(mailDoc);

        console.log(
            "onUserReportCreated: reportId=%s reporterId=%s reportedUserId=%s mailedTo=%s",
            reportId,
            fields.reporterId || "(none)",
            fields.reportedUserId || "(none)",
            reporterEmail || "(support-only)",
        );
        return null;
    },
);
