import {
    defaultPrompt,
    bloggerPrompt,
    expertPrompt,
    catPrompt,
    summaryPrompt,
    gamerPrompt,
    imageRecognitionPrompt,
    researchPrompt,
} from "./prompts.mjs";

export const personasToPromptMapping = {
    default: defaultPrompt,
    blogger: bloggerPrompt,
    expert: expertPrompt,
    cat: catPrompt,
    gamer: gamerPrompt,
};

const setPreferedLanguage = (systemPrompt, language) => {
    if (language) {
        return systemPrompt + `\n    - Answer in ${language} language.`;
    }
    return systemPrompt + "\n    - Answer in the language of the question.";
};

/**
 * Returns the system prompt for the given persona key.
 * Falls back to the default prompt if the key is unknown or missing.
 *
 * @param {string} personaKey - One of: "dreamer", "professor", "cat", "default"
 * @returns {string} The matching system prompt
 */
export const getSystemPrompt = (personaKey, language) => {
    const key = (personaKey || "").toLowerCase().trim();
    const systemPrompt = personasToPromptMapping[key] || personasToPromptMapping.default;
    return setPreferedLanguage(systemPrompt, language);
};

export const getImageRecognitionPrompt = (language) => {
    return setPreferedLanguage(imageRecognitionPrompt, language);
};

export const getSummaryPrompt = (language) => {
    return setPreferedLanguage(summaryPrompt, language);
};

export const getResearchPrompt = (language) => {
    return setPreferedLanguage(researchPrompt, language);
};

export const buildConversationBlock = (conversation) => `
    Conversation History:
    - Consider the below conversation history when answering the users question:

    <BEGIN_OF_CONVERSATION_HISTORY>
    ${conversation?.trim() || "(no prior messages)"}
    <END_OF_CONVERSATION_HISTORY>`;

export const buildResearchSystemPrompt = (language, conversation) => {
    const prompt = getResearchPrompt(language);
    return `${prompt}${buildConversationBlock(conversation)}`;
};

export const buildPersonaSystemPrompt = (personaKey, language, conversation) => {
    const systemPrompt = getSystemPrompt(personaKey, language);
    return `${systemPrompt}${buildConversationBlock(conversation)}`;
};

export const buildPersonaUserInput = (researchSummary, userQuestion) => `Research summary (use only these facts, do not add new information):
---
${researchSummary}
---

User question: ${userQuestion}`;
