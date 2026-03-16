import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { answerToPrompt } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { getSystemPrompt } from "../system-prompt.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const FUNCTION_NAME = "imageAnnotation";

const processImageAnnotationPrompt = async (payload) => {
    validateMandatoryFields(payload, ["input", "persona", "language"]);
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

export const imageAnnotation = onRequest({ cors: true, region: "europe-west3", secrets: [openaiApiKey] }, async (req, res) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(req);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const result = await processImageAnnotationPrompt(req.body);
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=200`);
        res.json(result);
    } catch (error) {
        console.error("image-annotation error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "image-annotation failed"),
        };
        res.status(statusCode).json(errorBody);
    }
});
