import { answerToPrompt } from "../open-ai-service.mjs";
import { mainSystemPrompt } from "../prompt.mjs";
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

const buildTextSystemPrompt = (conversation) => {
    return `${textSystemPrompt}
<BEGIN_OF_CONVERSATION_HISTORY>
${conversation || ""}
<END_OF_CONVERSATION_HISTORY>`;
};

const processTextPrompt = async (payload) => {
    validateMandatoryFields(payload, ["input", "conversation"])
    const topic = payload.input.trim();
    const systemPrompt = buildTextSystemPrompt(payload.conversation);
    const userPrompt = `Tell me about ${topic}.`;

    const userPromptResponse = await answerToPrompt(systemPrompt, userPrompt);
    console.log("user_prompt_response = " + userPromptResponse);

    if (payload.generate_summary) {
        console.log("generating summary with prompt = " + topic);

        const summarySystemPrompt = `You are an expert in creating a title for short texts.`;
        const summaryUserPrompt = `
Return a maximum 2 tokens title for the topic of the sentence below. Do not return anything else, only the maximum of 2 tokens. One token is also fine.
Examples:
- For the sentence "Tell me about the Havanese dogs" you return "Havanese dogs"
- For the sentence "Tell me what you know about the Eiffel Tower" you return "Eiffel Tower"

Sentence to create a title for:
${topic}`;
        const responseSummary = await answerToPrompt(summarySystemPrompt, summaryUserPrompt);
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

const textSystemPrompt = `
${mainSystemPrompt}

Conversation History:
- Consider the below conversation history when answering the users question: `;
