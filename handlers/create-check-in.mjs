import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { requireAuth } from "../utils/auth.mjs";
import { getClient } from "../services/open-ai-service.mjs";
import { createModerationStore } from "../services/content-moderation-store.mjs";
import {
    CONTENT_REJECTED,
    moderateUserContent,
    publishCheckIn,
} from "../services/content-moderation.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");
const FUNCTION_NAME = "createCheckIn";

const sendError = (res, error) => {
    const statusCode = error?.statusCode || error?.status || 500;
    console.error("%s error: %s", FUNCTION_NAME, error?.message || error);
    let errorCode = error?.message || "create-check-in failed";
    if (statusCode === 422) errorCode = CONTENT_REJECTED;
    else if (statusCode === 401) errorCode = "unauthorized";
    res.status(statusCode).json({ error: errorCode });
};

export const createCheckIn = onRequest(
    {
        cors: true,
        region: "europe-west3",
        secrets: [openaiApiKey],
        timeoutSeconds: 60,
        memory: "512MiB",
    },
    async (req, res) => {
        const start = Date.now();
        try {
            if (req.method !== "POST") {
                res.status(405).json({ error: "method not allowed" });
                return;
            }
            const decoded = await requireAuth(req);
            const store = createModerationStore(getFirestore(), getStorage().bucket());
            const result = await publishCheckIn({
                store,
                moderate: (input) => moderateUserContent(getClient(), input),
                uid: decoded.uid,
                body: req.body,
                serverTimestamp: FieldValue.serverTimestamp(),
            });
            console.log(
                "[%s] request completed in %dms status=200 uid=%s result=%s",
                FUNCTION_NAME,
                Date.now() - start,
                decoded.uid,
                result.status,
            );
            res.json(result);
        } catch (error) {
            const statusCode = error?.statusCode || error?.status || 500;
            console.log(
                "[%s] request completed in %dms status=%s",
                FUNCTION_NAME,
                Date.now() - start,
                statusCode,
            );
            sendError(res, error);
        }
    },
);
