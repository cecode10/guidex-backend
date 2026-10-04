import { onSchedule } from "firebase-functions/v2/scheduler";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { purgeExpiredReportEvidence } from "../services/report-evidence.mjs";
import { createReportEvidenceStore } from "../services/report-evidence-store.mjs";

/**
 * Deletes report evidence (Firestore copy and Storage files) once its
 * retention period ends. The report document itself is kept.
 */
export const purgeReportEvidence = onSchedule(
    {
        schedule: "every day 03:30",
        timeZone: "Europe/Berlin",
        region: "europe-west3",
        timeoutSeconds: 300,
    },
    async () => {
        const store = createReportEvidenceStore(getFirestore(), getStorage().bucket(), getAuth());
        const purged = await purgeExpiredReportEvidence({ store, nowMs: Date.now() });
        console.log("purgeReportEvidence: purged=%d", purged);
    },
);
