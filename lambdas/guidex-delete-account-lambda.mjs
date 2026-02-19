import { deleteFirebaseUser } from "../google-service.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields, parseRequestBody } from "../event-utils.mjs";

const toHttpResponse = (statusCode, body) => {
    return {
        statusCode,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        body: JSON.stringify(body),
    };
};

export const handler = async (event) => {
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");

        const payload = parseRequestBody(event);
        validateMandatoryFields(payload, ["uid"]);

        if (payload.uid !== decoded.uid) {
            const err = new Error("you can only delete your own account");
            err.statusCode = 403;
            throw err;
        }

        const result = await deleteFirebaseUser(payload.uid);
        return toHttpResponse(200, result);
    } catch (error) {
        console.error("delete-account error:", error?.message || error);
        const statusCode = error?.statusCode || error?.status || 500;
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "delete-account failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};
