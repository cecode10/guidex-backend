import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { answerToPrompt } from "../open-ai-service.mjs";
import { getSystemPrompt, getSummaryPrompt } from "../system-prompt.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const FUNCTION_NAME = "textPrompt";

const buildSystemPromptWithChatHistory = (systemPrompt, conversation) => {
    if (conversation) {
        return `${systemPrompt}
        Conversation History:
        - Consider the below conversation history when answering the users question:

        <BEGIN_OF_CONVERSATION_HISTORY>
        ${conversation}
        <END_OF_CONVERSATION_HISTORY>`;
    }
    return systemPrompt;
};

const processTextPrompt = async (payload) => {
    validateMandatoryFields(payload, ["input", "persona", "language"]);
    const topic = payload.input.trim();
    const persona = payload.persona.trim();
    const language = payload.language.trim();
    const systemPrompt = getSystemPrompt(persona);
    const systemPromptWithChatHistory = buildSystemPromptWithChatHistory(systemPrompt, payload.conversation);
    const userPrompt = `${topic}`;

    const userPromptResponse = await answerToPrompt(systemPromptWithChatHistory, userPrompt);
    console.log("response = " + userPromptResponse);

    if (payload.generate_summary) {
        console.log("generating summary with prompt = " + topic);
        const summaryPrompt = getSummaryPrompt(language);
        const responseSummary = await answerToPrompt(summaryPrompt, topic);
        console.log("response_summary = " + responseSummary);
        return {
            response_summary: responseSummary,
            response: userPromptResponse,
        };
    }
    return {
        response: userPromptResponse,
    };
};

export const textPrompt = onRequest({ cors: true, region: "europe-west3", secrets: [openaiApiKey] }, async (req, res) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(req);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const result = await processTextPrompt(req.body);
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=200`);
        res.json(result);
    } catch (error) {
        console.error("text-prompt error:", error?.message || error);
        const statusCode = error?.statusCode || error?.status || 500;
        const elapsed = Date.now() - start;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || error?.error?.message || "text-prompt failed"),
        };
        res.status(statusCode).json(errorBody);
    }
});
