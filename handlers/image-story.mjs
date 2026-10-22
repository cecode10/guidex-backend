import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { analyzeImageStreaming, genereateSummary } from "../services/open-ai-service.mjs";
import { parseImageStoryStream } from "../services/image-story-stream.mjs";
import { requireAuth } from "../utils/auth.mjs";
import { validateMandatoryFields } from "../utils/event-utils.mjs";
import { buildImageStoryUserPrompt } from "../prompts/prompts.mjs";
import { getSummaryPrompt, getSystemPrompt } from "../prompts/system-prompt.mjs";
import { candidateToPlacePayload, findNearbyLandmarks } from "../services/google-places-nearby.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");
const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");

const FUNCTION_NAME = "imageStory";
const SUMMARY_INPUT_CHARS = 2000;
/** Nearby candidates sent to the app; the prompt gets all of them. */
const CANDIDATES_EVENT_LIMIT = 5;

const sendSseEvent = (res, data, event) => {
    if (event) {
        res.write(`event: ${event}\n`);
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

/**
 * @param {unknown} location
 * @returns {{ lat: number, lon: number, accuracy: number | null } | null}
 */
const parseLocation = (location) => {
    if (!location || typeof location !== "object") return null;
    const { lat, lon, accuracy } = /** @type {Record<string, unknown>} */ (location);
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    const accuracyM = Number(accuracy);
    return { lat: latitude, lon: longitude, accuracy: Number.isFinite(accuracyM) ? accuracyM : null };
};

/**
 * Nearby landmarks for the prompt. A failure only costs grounding, never the story.
 *
 * @param {{ lat: number, lon: number, accuracy: number | null } | null} location
 * @param {string} language
 * @returns {Promise<Array<Record<string, any>>>}
 */
const loadCandidates = async (location, language) => {
    if (!location) return [];
    const started = Date.now();
    try {
        const { candidates, radiusM } = await findNearbyLandmarks(
            { ...location, language },
            { apiKey: googleMapsApiKey.value() },
        );
        console.log(
            `[${FUNCTION_NAME}] candidates=${candidates.length} radius=${radiusM}m in ${Date.now() - started}ms`,
        );
        return candidates;
    } catch (error) {
        console.error(`[${FUNCTION_NAME}] nearby landmarks failed:`, error?.message || error);
        return [];
    }
};

const finishSse = (res, start) => {
    res.write("data: [DONE]\n\n");
    console.log(`[${FUNCTION_NAME}] stream completed in ${Date.now() - start}ms`);
    res.end();
};

export const imageStory = onRequest(
    { cors: true, region: "europe-west3", secrets: [openaiApiKey, googleMapsApiKey], timeoutSeconds: 120 },
    async (req, res) => {
        const start = Date.now();
        try {
            const decoded = await requireAuth(req);
            console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");

            const payload = req.body;
            validateMandatoryFields(payload, ["input", "persona", "language"]);

            const imageBase64 = payload.input.trim();
            const persona = payload.persona.trim();
            const language = payload.language.trim();
            const systemPrompt = getSystemPrompt(persona, language);
            const candidates = await loadCandidates(parseLocation(payload.location), language);
            const userPrompt = buildImageStoryUserPrompt(payload.location, candidates);

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            });

            if (candidates.length > 0) {
                sendSseEvent(res, {
                    candidates: candidates.slice(0, CANDIDATES_EVENT_LIMIT).map(candidateToPlacePayload),
                });
            }

            let needsSummary = false;
            let story = "";
            const tokenStream = analyzeImageStreaming(imageBase64, userPrompt, systemPrompt);
            for await (const event of parseImageStoryStream(tokenStream)) {
                if (event.type === "unrecognized") {
                    sendSseEvent(res, { unrecognized: true });
                    finishSse(res, start);
                    return;
                }
                if (event.type === "name") {
                    sendSseEvent(res, { name: event.name });
                    continue;
                }
                if (event.type === "place") {
                    const match = candidates.find((c) => c.ref === event.ref);
                    if (match) {
                        sendSseEvent(res, { place: candidateToPlacePayload(match) });
                    }
                    continue;
                }
                if (event.type === "token") {
                    story += event.token;
                    sendSseEvent(res, { token: event.token });
                    continue;
                }
                if (event.type === "needs_summary") {
                    needsSummary = true;
                }
            }

            if (needsSummary && story.trim()) {
                try {
                    const summary = (await genereateSummary(
                        getSummaryPrompt(language),
                        story.slice(0, SUMMARY_INPUT_CHARS),
                    ) || "").trim();
                    if (summary) {
                        sendSseEvent(res, { name: summary });
                    }
                } catch (error) {
                    console.error("image-story summary failed:", error?.message || error);
                }
            }

            finishSse(res, start);
        } catch (error) {
            console.error("image-story error:", error?.message || error);
            const statusCode = error?.statusCode || error?.status || 500;
            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);

            if (res.headersSent) {
                sendSseEvent(res, { error: error?.message || "stream failed" }, "error");
                res.end();
            } else {
                const errorBody = {
                    error: statusCode === 401 ? "unauthorized" : (error?.message || "image-story failed"),
                };
                res.status(statusCode).json(errorBody);
            }
        }
    },
);
