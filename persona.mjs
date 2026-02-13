import {
    defaultPrompt,
    dreamerPrompt,
    professorPrompt,
    catPrompt,
} from "./prompt.mjs";

const personas = {
    default: defaultPrompt,
    dreamer: dreamerPrompt,
    professor: professorPrompt,
    cat: catPrompt,
};

/**
 * Returns the system prompt for the given persona key.
 * Falls back to the default prompt if the key is unknown or missing.
 *
 * @param {string} personaKey - One of: "dreamer", "professor", "cat", "default"
 * @returns {string} The matching system prompt
 */
export const getSystemPrompt = (personaKey) => {
    const key = (personaKey || "").toLowerCase().trim();
    return personas[key] || personas.default;
};
