import {
    defaultPrompt,
    dreamerPrompt,
    professorPrompt,
    catPrompt,
} from "./prompts.mjs";

const personas = {
    default: defaultPrompt,
    dreamer: dreamerPrompt,
    professor: professorPrompt,
    cat: catPrompt,
};

const setPreferedLanguage = (systemPrompt, language) => {
    if (language) {
        return systemPrompt + `\n    - Answer the question in ${language} language.`;
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
    const systemPrompt = personas[key] || personas.default;
    return setPreferedLanguage(systemPrompt, language);
};
