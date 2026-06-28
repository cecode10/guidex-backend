import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { answerToPrompt } from "../open-ai-service.mjs";
import { getSummaryPrompt } from "../system-prompt.mjs";
import { streamTwoAgentResponse } from "../agent-pipeline.mjs";
import { requireAuth } from "../auth.mjs";
import { validateMandatoryFields } from "../event-utils.mjs";

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const FUNCTION_NAME = "textPrompt";

const sendSseEvent = (res, data, event) => {
    if (event) {
        res.write(`event: ${event}\n`);
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

export const textPrompt = onRequest(
    { cors: true, region: "europe-west3", secrets: [openaiApiKey], timeoutSeconds: 120 },
    async (req, res) => {
        const start = Date.now();
        try {
            const decoded = await requireAuth(req);
            console.log("auth: uid=%s email=%s", decoded.uid, decoded.email || "(none)");

            const payload = req.body;
            validateMandatoryFields(payload, ["input", "persona", "language"]);

            const topic = payload.input.trim();
            const persona = payload.persona.trim();
            const language = payload.language.trim();

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            });

            if (payload.generate_summary) {
                console.log("generating summary with prompt = " + topic);
                const summaryPrompt = getSummaryPrompt(language);
                const responseSummary = await answerToPrompt(summaryPrompt, topic);
                console.log("response_summary = " + responseSummary);
                sendSseEvent(res, { response_summary: responseSummary }, "summary");
            }

            const tokenStream = streamTwoAgentResponse({
                userQuestion: topic,
                persona,
                language,
                conversation: payload.conversation,
                pipeline: FUNCTION_NAME,
            });
            for await (const token of tokenStream) {
                sendSseEvent(res, { token });
            }

            res.write("data: [DONE]\n\n");
            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] stream completed in ${elapsed}ms`);
            res.end();
        } catch (error) {
            console.error("text-prompt error:", error?.message || error);
            const statusCode = error?.statusCode || error?.status || 500;
            const elapsed = Date.now() - start;
            console.log(`[${FUNCTION_NAME}] request completed in ${elapsed}ms status=${statusCode}`);

            if (res.headersSent) {
                sendSseEvent(res, { error: error?.message || "stream failed" }, "error");
                res.end();
            } else {
                const errorBody = {
                    error: statusCode === 401 ? "unauthorized" : (error?.message || error?.error?.message || "text-prompt failed"),
                };
                res.status(statusCode).json(errorBody);
            }
        }
    },
);
