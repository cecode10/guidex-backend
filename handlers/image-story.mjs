import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { analyzeImageStreaming, genereateSummary } from "../services/open-ai-service.mjs";
import { parseImageStoryStream } from "../services/image-story-stream.mjs";
import { requireAuth } from "../utils/auth.mjs";
import { validateMandatoryFields } from "../utils/event-utils.mjs";
import { buildImageStoryUserPrompt } from "../prompts/prompts.mjs";
import { getSummaryPrompt, getSystemPrompt } from "../prompts/system-prompt.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const FUNCTION_NAME = "imageStory";
const SUMMARY_INPUT_CHARS = 2000;

const sendSseEvent = (res, data, event) => {
    if (event) {
        res.write(`event: ${event}\n`);
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const finishSse = (res, start) => {
    res.write("data: [DONE]\n\n");
    console.log(`[${FUNCTION_NAME}] stream completed in ${Date.now() - start}ms`);
    res.end();
};

export const imageStory = onRequest(
    { cors: true, region: "europe-west3", secrets: [openaiApiKey], timeoutSeconds: 120 },
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
            const userPrompt = buildImageStoryUserPrompt(payload.location);

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            });

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
