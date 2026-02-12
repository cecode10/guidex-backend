import { answerToPrompt } from "../open-ai-service.mjs";
import { mainSystemPrompt } from "../prompt.mjs";
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

const processImageAnnotationPrompt = async (payload) => {
    validateMandatoryFields(payload, ["input"])
    const topic = payload.input.trim();
    const systemPrompt = imageSystemPrompt;
    const userPrompt = `Tell me about ${topic}.`;

    const userPromptResponse = await answerToPrompt(systemPrompt, userPrompt);
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
        const result = await processImageAnnotationPrompt(input);
        return toHttpResponse(200, result);
    } catch (error) {
        console.error("image-annotation error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "image-annotation failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};

const imageSystemPrompt = `
${mainSystemPrompt}
`;
