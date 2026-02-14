import { answerToPrompt } from "../open-ai-service.mjs";
import { summarySystemPrompt, buildSummaryUserPrompt } from "../prompt.mjs";
import { getSystemPrompt } from "../persona.mjs";
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

const buildSystemPromptWithChatHisotry = (systemPrompt, conversation) => {
    return `${systemPrompt}
Conversation History:
- Consider the below conversation history when answering the users question:

<BEGIN_OF_CONVERSATION_HISTORY>
${conversation || ""}
<END_OF_CONVERSATION_HISTORY>`;
};

const processTextPrompt = async (payload) => {
    validateMandatoryFields(payload, ["input", "persona"])
    const topic = payload.input.trim();
    const persona = payload.persona.trim();
    const systemPromptWithChatHistory = buildSystemPromptWithChatHisotry(getSystemPrompt(persona), payload.conversation);
    const userPrompt = `${topic}`;

    const userPromptResponse = await answerToPrompt(systemPromptWithChatHistory, userPrompt);
    console.log("user_prompt_response = " + userPromptResponse);

    if (payload.generate_summary) {
        console.log("generating summary with prompt = " + topic);

        const responseSummary = await answerToPrompt(summarySystemPrompt, buildSummaryUserPrompt(topic));
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

export const handler = async (event) => {
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const input = parseRequestBody(event);
        const result = await processTextPrompt(input);
        return toHttpResponse(200, result);
    } catch (error) {
        console.error("text-prompt error:", error?.message || error);
        const statusCode = error?.statusCode || error?.status || 500;
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || error?.error?.message || "text-prompt failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};

