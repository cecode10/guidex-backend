import { onRequest } from "firebase-functions/v2/https";
import { deleteFirebaseUser } from "../google-service.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";

const FUNCTION_NAME = "deleteAccount";

export const deleteAccount = onRequest({ cors: true, region: "europe-west3" }, async (req, res) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(req);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");

        const payload = req.body;
        validateMandatoryFields(payload, ["uid"]);

        if (payload.uid !== decoded.uid) {
            const err = new Error("you can only delete your own account");
            err.statusCode = 403;
            throw err;
        }

        const result = await deleteFirebaseUser(payload.uid);
        const elapsed = Date.now() - start;
        console.log(
            `[${FUNCTION_NAME}] request completed in ${elapsed}ms status=200 followingRemoved=%d followersRemoved=%d`,
            result.followingRemoved ?? 0,
            result.followersRemoved ?? 0,
        );
        res.json(result);
    } catch (error) {
        console.error("delete-account error:", error?.message || error);
        const statusCode = error?.statusCode || error?.status || 500;
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "delete-account failed"),
        };
        res.status(statusCode).json(errorBody);
    }
});
