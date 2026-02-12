import { analyzeImage } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { parseRequestBody, validateMandatoryFields } from "../event-utils.mjs";

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

const processImageRecognition = async (payload) => {
    validateMandatoryFields(payload, ["input"])
    const imageBase64 = payload.input.trim();
    const userPromptResponse = await analyzeImage(imageBase64, payload.location);
    console.log("user_prompt_response = " + userPromptResponse);
    return {
        response: userPromptResponse,
    };
};

export const handler = async (event) => {
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");

        const input = parseRequestBody(event);
        const result = await processImageRecognition(input);
        return toHttpResponse(200, result);
    } catch (error) {
        console.error("image-recognition error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "image-recognition failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};
