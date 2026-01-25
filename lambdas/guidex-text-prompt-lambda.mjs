import { answerToPrompt } from "../open-ai-service.mjs";
import { mainSystemPrompt } from "../prompt.mjs";

const parseRequestBody = (event) => {
    if (!event) {
        return {};
    }
    if (typeof event === "string") {
        return JSON.parse(event);
    }
    if (event.body) {
        if (typeof event.body === "string") {
            return JSON.parse(event.body);
        }
        return event.body;
    }
    return event;
};

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

const getAllowedUsers = () => {
    const input = process.env.PERMITTED_USERS;
    if (!input) {
        throw new Error("missing permitted users");
    }
    return input
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean);
};

const assertAllowedUser = (user, allowedUsers) => {
    const userEmail = user?.trim();
    if (!userEmail) {
        throw new Error("user is required");
    }
    if (!allowedUsers.includes(userEmail)) {
        const error = new Error("not-allowed");
        error.statusCode = 403;
        throw error;
    }
};

const buildTextSystemPrompt = (conversation) => {
    return `${textSystemPrompt}
<BEGIN_OF_CONVERSATION_HISTORY>
${conversation || ""}
<END_OF_CONVERSATION_HISTORY>`;
};

const processTextPrompt = async (input) => {
    const topic = input.input?.trim();
    if (!topic) {
        throw new Error("input is required");
    }

    const systemPrompt = buildTextSystemPrompt(input.conversation);
    const userPrompt = `Tell me about ${topic}.`;

    const userPromptResponse = await answerToPrompt(systemPrompt, userPrompt);
    console.log("user_prompt_response = " + userPromptResponse);

    if (input.generate_summary) {
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
    const isHttpRequest = Boolean(
        event?.requestContext || event?.rawPath || event?.httpMethod || event?.headers
    );

    try {
        const input = parseRequestBody(event);
        const allowedUsers = getAllowedUsers();
        assertAllowedUser(input.user, allowedUsers);

        const result = await processTextPrompt(input);
        return isHttpRequest ? toHttpResponse(200, result) : result;
    } catch (error) {
        console.error(error?.message || error);
        const statusCode = error?.statusCode || 500;
        const errorBody = {
            error: error?.message || "text-prompt failed",
        };
        return isHttpRequest ? toHttpResponse(statusCode, errorBody) : errorBody;
    }
};

const textSystemPrompt = `
${mainSystemPrompt}

Conversation History:
- Consider the below conversation history when answering the users question: `;
