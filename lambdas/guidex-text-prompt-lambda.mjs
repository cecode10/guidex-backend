import {answerToPrompt} from "../open-ai-service.mjs";
import {getSystemPrompt, getSummaryPrompt} from "../system-prompt.mjs";
import {requireAuth} from "../auth.mjs";
import {validateMandatoryFields, parseRequestBody} from "../event-utils.mjs";

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
    validateMandatoryFields(payload, ["input", "persona", "language"])
    const topic = payload.input.trim();
    const persona = payload.persona.trim();
    const language = payload.language.trim();
    const systemPrompt = getSystemPrompt(persona);
    const systemPromptWithChatHistory = buildSystemPromptWithChatHisotry(systemPrompt, payload.conversation);
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

const LAMBDA_NAME = "text-prompt";

export const handler = async (event) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const input = parseRequestBody(event);
        const result = await processTextPrompt(input);
        const elapsed = Date.now() - start;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=200`);
        return toHttpResponse(200, result);
    } catch (error) {
        console.error("text-prompt error:", error?.message || error);
        const statusCode = error?.statusCode || error?.status || 500;
        const elapsed = Date.now() - start;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || error?.error?.message || "text-prompt failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};

