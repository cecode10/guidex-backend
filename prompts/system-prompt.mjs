import {
    defaultPrompt,
    bloggerPrompt,
    expertPrompt,
    catPrompt,
    summaryPrompt,
    gamerPrompt,
    imageRecognitionPrompt
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
}
