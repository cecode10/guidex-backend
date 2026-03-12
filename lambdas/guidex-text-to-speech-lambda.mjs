import { textToSpeech } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { parseRequestBody, validateMandatoryFields } from "../event-utils.mjs";
import { personasToPromptMapping } from "../system-prompt.mjs";

const GENDER_TO_VOICE = {
    female: "marin",
    male: "echo",
};
const VOICE_ALLOY = "alloy";
const VOICE_FABLE = "fable";

export const personas = {
    blogger: "blogger",
    expert: "expert",
    cat: "cat",
    gamer: "gamer",
};

const toHttpResponse = (statusCode, body) => ({
    statusCode,
    headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
    },
    body: JSON.stringify(body),
});

const LAMBDA_NAME = "text-to-speech";

export const handler = async (event) => {
    const start = Date.now();
    try {
        const decoded = await requireAuth(event);
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");
        const body = parseRequestBody(event);

        validateMandatoryFields(body, ["text", "persona", "gender"]);

        const inputText = body.text.trim();
        const persona = body.persona.trim();
        const gender = body.gender.trim();
        let voice = GENDER_TO_VOICE[gender.toLowerCase()] ?? VOICE_ALLOY;
        if (personas.cat === persona.toLowerCase()) {
            voice = VOICE_FABLE;
        }
        const audioBase64 = await textToSpeech(inputText, { voice });
        const elapsed = Date.now() - start;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=200`);
        return toHttpResponse(200, { audio: audioBase64 });
    } catch (error) {
        console.error("text-to-speech error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const elapsed = Date.now() - start;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "text-to-speech failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};
