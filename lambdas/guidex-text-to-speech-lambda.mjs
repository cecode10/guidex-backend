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
    const t0 = Date.now();
    try {
        const decoded = await requireAuth(event);
        const tAuth = Date.now();
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
        const tTts = Date.now();
        const resp = toHttpResponse(200, { audio: audioBase64 });
        const tJson = Date.now();
        console.log(
            `[${LAMBDA_NAME}] auth=${tAuth - t0}ms tts=${tTts - tAuth}ms json=${tJson - tTts}ms total=${tJson - t0}ms status=200`,
        );
        return resp;
    } catch (error) {
        console.error("text-to-speech error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const elapsed = Date.now() - t0;
        console.log(`[${LAMBDA_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "text-to-speech failed"),
        };
        return toHttpResponse(statusCode, errorBody);
    }
};
