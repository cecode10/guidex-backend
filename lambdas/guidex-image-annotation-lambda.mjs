import { answerToPrompt } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { parseRequestBody, validateMandatoryFields } from "../event-utils.mjs";
import { getSystemPrompt } from "../system-prompt.mjs";

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

const processImageAnnotationPrompt = async (payload) => {
    validateMandatoryFields(payload, ["input", "persona", "language"])
    const topic = payload.input.trim();
    const persona = payload.persona.trim();
    const language = payload.language.trim();
    const userPrompt = `Tell me about ${topic}$`;
    const systemPrompt = getSystemPrompt(persona, language);
    const modelResponse = await answerToPrompt(systemPrompt, userPrompt);
    console.log("assistant response = " + modelResponse);

    return {
        response: modelResponse,
    };
};

const LAMBDA_NAME = "image-annotation";

export const handler = async (event) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const input = parseRequestBody(event);
        const result = await processImageAnnotationPrompt(input);
        const elapsed = Date.now() - start;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=200`);
        return toHttpResponse(200, result);
    } catch (error) {
        console.error("image-annotation error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const elapsed = Date.now() - start;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "image-annotation failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};
