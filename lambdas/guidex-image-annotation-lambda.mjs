import { answerToPrompt } from "../open-ai-service.mjs";
import { defaultPrompt } from "../prompt.mjs";
import { requireAuth } from "../auth.mjs";
import { parseRequestBody, validateMandatoryFields } from "../event-utils.mjs";
import { getSystemPrompt } from "../persona.mjs";

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
    validateMandatoryFields(payload, ["input", "persona"])
    const topic = payload.input.trim();
    const persona = payload.persona.trim();
    const userPrompt = `Tell me about ${topic}`;

    const userPromptResponse = await answerToPrompt(getSystemPrompt(persona), userPrompt);
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
