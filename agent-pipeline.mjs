import { researchFromWebSearch, personaRetellStreaming } from "./open-ai-service.mjs";
import {
    buildResearchSystemPrompt,
    buildPersonaSystemPrompt,
    buildPersonaUserInput,
} from "./system-prompt.mjs";

export async function* streamTwoAgentResponse({
    userQuestion,
    persona,
    language,
    conversation,
    pipeline,
}) {
    const researchSystemPrompt = buildResearchSystemPrompt(language, conversation);
    const researchSummary = await researchFromWebSearch(
        researchSystemPrompt,
        userQuestion,
        { pipeline },
    );

    const personaSystemPrompt = buildPersonaSystemPrompt(persona, language, conversation);
    const personaUserInput = buildPersonaUserInput(researchSummary, userQuestion);
    const tokenStream = personaRetellStreaming(
        personaSystemPrompt,
        personaUserInput,
        { pipeline, persona },
    );

    for await (const token of tokenStream) {
        yield token;
    }
}
