import { onRequest } from "firebase-functions/v2/https";
import { sendSignupEmailVerification } from "../services/email-verification-service.mjs";
import { requireAuth } from "../utils/auth.mjs";
import { mailFunctionSecrets } from "../utils/mail-params.mjs";

const FUNCTION_NAME = "sendEmailVerification";

export const sendEmailVerification = onRequest(
    { cors: true, region: "europe-west3", secrets: mailFunctionSecrets },
    async (req, res) => {
        const start = Date.now();
        try {
            const decoded = await requireAuth(req);
            const result = await sendSignupEmailVerification({
                uid: decoded.uid,
                email: decoded.email,
            });
            const elapsed = Date.now() - start;
            console.log(
                "[%s] request completed in %dms status=200 uid=%s alreadyVerified=%s",
                FUNCTION_NAME,
                elapsed,
                decoded.uid,
                result.alreadyVerified,
            );
            res.json(result);
        } catch (error) {
            console.error("send-email-verification error:", error?.message || error);
            const statusCode = error?.statusCode || error?.status || 500;
            const elapsed = Date.now() - start;
            console.log("[%s] request completed in %dms status=%s", FUNCTION_NAME, elapsed, statusCode);
            res.status(statusCode).json({
                error: statusCode === 401 ? "unauthorized" : (error?.message || "send-email-verification failed"),
            });
        }
    },
);
