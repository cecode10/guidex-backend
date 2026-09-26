import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getClient } from "../services/open-ai-service.mjs";
import { createModerationStore } from "../services/content-moderation-store.mjs";
import {
    moderateUserContent,
    retryPendingCheckIn,
    retryPendingProfile,
} from "../services/content-moderation.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

/**
 * Re-checks posts and profile fields that were published while moderation
 * was unavailable. A later rejection removes the check-in and restores the
 * previous profile fields.
 */
export const retryPendingModeration = onSchedule(
    {
        schedule: "every 15 minutes",
        region: "europe-west3",
        secrets: [openaiApiKey],
        timeoutSeconds: 300,
        memory: "512MiB",
    },
    async () => {
        const store = createModerationStore(getFirestore(), getStorage().bucket());
        const moderate = (input) => moderateUserContent(getClient(), input);
        const serverTimestamp = FieldValue.serverTimestamp();

        const checkIns = await store.listPendingCheckIns(20);
        for (const item of checkIns) {
            if (!item.uid) continue;
            try {
                const result = await retryPendingCheckIn({
                    store,
                    moderate,
                    uid: item.uid,
                    checkInId: item.id,
                    data: item.data,
                    serverTimestamp,
                });
                console.log(
                    "retryPendingModeration checkin uid=%s id=%s status=%s",
                    item.uid,
                    item.id,
                    result.status,
                );
            } catch (error) {
                console.error(
                    "retryPendingModeration checkin failed uid=%s id=%s error=%s",
                    item.uid,
                    item.id,
                    error?.message || error,
                );
            }
        }

        const profiles = await store.listPendingProfiles(20);
        for (const item of profiles) {
            try {
                const result = await retryPendingProfile({
                    store,
                    moderate,
                    uid: item.uid,
                    data: item.data,
                    serverTimestamp,
                });
                console.log(
                    "retryPendingModeration profile uid=%s status=%s",
                    item.uid,
                    result.status,
                );
            } catch (error) {
                console.error(
                    "retryPendingModeration profile failed uid=%s error=%s",
                    item.uid,
                    error?.message || error,
                );
            }
        }
    },
);
