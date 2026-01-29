import { textToSpeech } from "../open-ai-service.mjs";

export const handler = async (event) => {
    try {
        return {
            statusCode: 200,
            body: await textToSpeech(event.text),
        };
    } catch (error) {
        console.error("TTS Synthesis Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};