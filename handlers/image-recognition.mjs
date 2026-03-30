import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { analyzeImage } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";
import { buildLocationPrompt } from "../prompts.mjs";
import { getImageRecognitionPrompt } from "../system-prompt.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const FUNCTION_NAME = "imageRecognition";

const processImageRecognition = async (payload) => {
    validateMandatoryFields(payload, ["input"]);
    const imageBase64 = payload.input.trim();
    const language = payload.language.trim();
    const systemPrompt = getImageRecognitionPrompt(language);
    const finalPrompt = [systemPrompt, buildLocationPrompt(payload.location)]
        .filter(Boolean)
        .join("\n");
    const userPromptResponse = await analyzeImage(imageBase64, finalPrompt);
    console.log("user_prompt_response = " + userPromptResponse);
    return {
        response: userPromptResponse,
    };
};

export const imageRecognition = onRequest({ cors: true, region: "europe-west3", secrets: [openaiApiKey] }, async (req, res) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(req);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const result = await processImageRecognition(req.body);
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=200`);
        res.json(result);
    } catch (error) {
        console.error("image-recognition error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "image-recognition failed"),
        };
        res.status(statusCode).json(errorBody);
    }
});
