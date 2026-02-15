import { textToSpeech } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { parseRequestBody, validateMandatoryFields } from "../event-utils.mjs";

const GENDER_TO_VOICE = {
    female: "marin",
    male: "echo",
};
const DEFAULT_VOICE = "alloy";

const toHttpResponse = (statusCode, body) => ({
    statusCode,
    headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
    },
    body: JSON.stringify(body),
});

export const handler = async (event) => {
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const body = parseRequestBody(event);

        validateMandatoryFields(body, ["text"]);
        const voice = GENDER_TO_VOICE[body.gender?.toLowerCase()] ?? DEFAULT_VOICE;
        const audioBase64 = await textToSpeech(body, { voice });
        return toHttpResponse(200, { audio: audioBase64 });
    } catch (error) {
        console.error("text-to-speech error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "text-to-speech failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};
