import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { sendMail } from "../services/mail-service.mjs";
import { captureReportEvidence } from "../services/report-evidence.mjs";
import { createReportEvidenceStore } from "../services/report-evidence-store.mjs";
import { mailFunctionSecrets } from "../utils/mail-params.mjs";
import {
    buildReportReceivedMail,
    buildReportSupportMail,
    emailFromUserDoc,
    reportFieldsFromDoc,
} from "../utils/user-report-email-utils.mjs";

/**
 * Saves evidence (copies of the reported post and the reported user's
 * profile), emails support the full report details and, when the reporter has
 * an email, sends them a separate confirmation of receipt with only the report
 * reference.
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

        const evidenceStore = createReportEvidenceStore(db, getStorage().bucket(), getAuth());
        try {
            const evidence = await captureReportEvidence({
                store: evidenceStore,
                reportId,
                reportedUserId: fields.reportedUserId,
                postId: fields.postId,
                nowMs: Date.now(),
                capturedAt: FieldValue.serverTimestamp(),
                toTimestamp: (ms) => Timestamp.fromMillis(ms),
            });
            if (evidence) {
                await evidenceStore.saveEvidence(reportId, evidence);
                console.log(
                    "onUserReportCreated: evidence saved reportId=%s post=%s postImage=%s profile=%s avatar=%s",
                    reportId,
                    evidence.post?.status || "(none)",
                    evidence.post?.image?.copyStoragePath || evidence.post?.image?.copySkippedReason || "(none)",
                    evidence.profile?.status || "(none)",
                    evidence.profile?.avatar?.copyStoragePath || evidence.profile?.avatar?.copySkippedReason || "(none)",
                );
            }
        } catch (error) {
            console.error(
                "onUserReportCreated: evidence failed reportId=%s error=%s",
                reportId,
                error?.message || error,
            );
        }

        let reporterEmail = fields.reporterEmail;
        if (!reporterEmail && fields.reporterId) {
            const reporterDoc = await db.collection("users").doc(fields.reporterId).get();
            reporterEmail = emailFromUserDoc(reporterDoc.data());
        }

        const supportResult = await sendMail(buildReportSupportMail({
            ...fields,
            reporterEmail,
            reportId,
        }));
        if (supportResult.ok) {
            console.log(
                "onUserReportCreated: support mail sent reportId=%s reporterId=%s reportedUserId=%s postId=%s messageId=%s",
                reportId,
                fields.reporterId || "(none)",
                fields.reportedUserId || "(none)",
                fields.postId || "(none)",
                supportResult.messageId || "(none)",
            );
        } else {
            console.error(
                "onUserReportCreated: support mail failed reportId=%s error=%s",
                reportId,
                supportResult.error,
            );
        }

        if (!reporterEmail) return null;

        const reporterResult = await sendMail(buildReportReceivedMail({
            reporterEmail,
            reportId,
        }));
        if (reporterResult.ok) {
            console.log(
                "onUserReportCreated: reporter confirmation sent reportId=%s messageId=%s",
                reportId,
                reporterResult.messageId || "(none)",
            );
        } else {
            console.error(
                "onUserReportCreated: reporter confirmation failed reportId=%s error=%s",
                reportId,
                reporterResult.error,
            );
        }
        return null;
    },
);
