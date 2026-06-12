import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { textToSpeech } from "../open-ai-service.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const GENDER_TO_VOICE = {
    female: "marin",
    male: "echo",
};
const VOICE_ALLOY = "alloy";
const VOICE_FABLE = "fable";

const personas = {
    blogger: "blogger",
    expert: "expert",
    cat: "cat",
    gamer: "gamer",
};

const FUNCTION_NAME = "textToSpeech";

export const textToSpeechFn = onRequest({ cors: true, region: "europe-west3", secrets: [openaiApiKey] }, async (req, res) => {
    const t0 = Date.now();
    try {
        const decoded = await requireAuth(req);
        const tAuth = Date.now();
        console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");

        const body = req.body;
        validateMandatoryFields(body, ["text", "persona", "gender"]);

        const inputText = body.text.trim();
        const persona = body.persona.trim();
        const gender = body.gender.trim();
        const chapterIndex = Number(body.chapterIndex);
        const totalChapters = Number(body.totalChapters);
        if (
            Number.isInteger(chapterIndex) &&
            Number.isInteger(totalChapters) &&
            totalChapters > 0 &&
            chapterIndex >= 0 &&
            chapterIndex < totalChapters
        ) {
            console.log(`[${FUNCTION_NAME}] chapter ${chapterIndex + 1}/${totalChapters}`);
        }
        let voice = GENDER_TO_VOICE[gender.toLowerCase()] ?? VOICE_ALLOY;
        if (personas.cat === persona.toLowerCase()) {
            voice = VOICE_FABLE;
        }
        const audioBase64 = await textToSpeech(inputText, { voice });
        const tTts = Date.now();
        console.log(
            `[${FUNCTION_NAME}] auth=${tAuth - t0}ms tts=${tTts - tAuth}ms total=${tTts - t0}ms status=200`,
        );
        res.json({ audio: audioBase64 });
    } catch (error) {
        console.error("text-to-speech error:", error?.message || error);
        const statusCode = error?.statusCode || 500;
        const elapsed = Date.now() - t0;
        console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);
        const errorBody = {
            error: statusCode === 401 ? "unauthorized" : (error?.message || "text-to-speech failed"),
        };
        res.status(statusCode).json(errorBody);
    }
});
