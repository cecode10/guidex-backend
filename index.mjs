import {answerToPrompt, analyzeImage} from "./open-ai-service.mjs";
import { mainSystemPrompt } from "./prompt.mjs";

const processGeneralPrompt = async (event) => {

    const systemPrompt = textSystemPrompt + `
    <BEGIN_OF_CONVERSATION_HISTORY>
    ${event.conversation}
    <END_OF_CONVERSATION_HISTORY>
    `;

    const userPrompt = `Tell me about ${event.input}.`

    const userPromptResponse = await answerToPrompt(systemPrompt, userPrompt);
    console.log("user_prompt_response = " + userPromptResponse);

    if (event.generate_summary) {
        console.log("generating summary with prompt = " + event.input);

        const systemPrompt = `You are an expert in creating a title for short texts.`;
        const userPrompt = `
        Return a maximum 2 tokens title for the topic of the sentence below. Do not return anything else, only the maximum of 2 tokens. One token is also fine.
        Examples:
        - For the sentence "Tell me about the Havanese dogs" you return "Havanese dogs"
        - For the sentence "Tell me what you know about the Eiffel Tower" you return "Eiffel Tower"

        Sentence to create a title for:
        ${event.input}`;
        const responseSummary = await answerToPrompt(systemPrompt, userPrompt);
        console.log("response_summary = " + responseSummary);
        return {
            response_summary: responseSummary,
            response: userPromptResponse
        }
    }
    return {
        response: userPromptResponse
    }
}

const processLandmarkPrompt = async (event) => {
    console.log("processing image");
    const systemPrompt = imageSystemPrompt;
    const userPrompt = `Tell me about ${event.input}.`;

    const userPromptResponse = await answerToPrompt(systemPrompt, userPrompt);
    console.log("user_prompt_response = " + userPromptResponse);

    return {
        response: userPromptResponse
    }
}

const processImage = async (event) => {
    console.log("processing image");
    const imageBase64 = event.input;
    const userPromptResponse = await analyzeImage(imageBase64);
    console.log("user_prompt_response = " + userPromptResponse);
    return {
        response: userPromptResponse
    }
}

export const handler = async (event) => {
    try {
        console.log(event);

        if (!allowedUsers.includes(event.user)) {
            return {
                "error": "not-allowed"
            }
        }
        if (event.input_type == "general_prompt") {
            return processGeneralPrompt(event);
        }
        if (event.input_type == "landmark_prompt") {
            return processLandmarkPrompt(event);
        }
        if (event.input_type == "image") {
            return processImage(event);
        }
        throw new Error(`input type ${event.input_type
            } not allowed`);
    } catch (error) {
        console.error(error.message);
    }
}

const input = process.env.PERMITTED_USERS;
const allowedUsers = input
    .split(",")
    .map(email => email.trim());


const textSystemPrompt = `

    ${mainSystemPrompt}

    Conversation History:
    - Consider the below conversation history when ansering the users question: `;

const imageSystemPrompt = `
    ${mainSystemPrompt}
`;