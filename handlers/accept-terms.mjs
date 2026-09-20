import { onRequest } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { requireAuth } from "../utils/auth.mjs";
import {
    clientIpFromRequest,
    isTermsAlreadyAccepted,
    legalTermsAcceptance,
    optionalString,
    publicTermsAcceptance,
} from "../utils/terms-acceptance-utils.mjs";

const FUNCTION_NAME = "acceptTerms";

export const acceptTerms = onRequest(
    { cors: true, region: "europe-west3" },
    async (req, res) => {
        const start = Date.now();
        try {
            const decoded = await requireAuth(req);
            const body = req.body && typeof req.body === "object" ? req.body : {};
            const db = getFirestore();
            const userRef = db.collection("users").doc(decoded.uid);
            const existing = await userRef.get();
            const existingData = existing.data();

            if (existingData?.accountDeleted === true) {
                const err = new Error("account deleted");
                err.statusCode = 403;
                throw err;
            }

            if (isTermsAlreadyAccepted(existingData)) {
                const elapsed = Date.now() - start;
                console.log(
                    "[%s] request completed in %dms status=200 uid=%s alreadyAccepted=true",
                    FUNCTION_NAME,
                    elapsed,
                    decoded.uid,
                );
                res.json({
                    accepted: true,
                    alreadyAccepted: true,
                    termsAcceptance: existingData.termsAcceptance,
                });
                return;
            }

            const acceptedAt = FieldValue.serverTimestamp();
            const publicRecord = publicTermsAcceptance({ acceptedAt });
            const legalRecord = legalTermsAcceptance({
                acceptedAt,
                ipAddress: clientIpFromRequest(req),
                userAgent: optionalString(req.headers?.["user-agent"], 512),
                locale: optionalString(body.locale, 64),
                platform: body.platform,
            });

            const batch = db.batch();
            batch.set(userRef, { termsAcceptance: publicRecord }, { merge: true });
            batch.set(userRef.collection("legal").doc("termsAcceptance"), legalRecord);
            await batch.commit();

            const elapsed = Date.now() - start;
            console.log(
                "[%s] request completed in %dms status=200 uid=%s alreadyAccepted=false",
                FUNCTION_NAME,
                elapsed,
                decoded.uid,
            );
            res.json({
                accepted: true,
                alreadyAccepted: false,
                termsAcceptance: {
                    version: publicRecord.version,
                    url: publicRecord.url,
                },
            });
        } catch (error) {
            console.error("accept-terms error:", error?.message || error);
            const statusCode = error?.statusCode || error?.status || 500;
            const elapsed = Date.now() - start;
            console.log("[%s] request completed in %dms status=%s", FUNCTION_NAME, elapsed, statusCode);
            res.status(statusCode).json({
                error: statusCode === 401 ? "unauthorized" : (error?.message || "accept-terms failed"),
            });
        }
    },
);
