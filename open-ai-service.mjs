import OpenAI from "openai";

let openai;
const getClient = () => {
    if (!openai) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openai;
};

const model4o = "gpt-4o-mini";
const model41 = "gpt-4.1-mini";
const model40tts = "gpt-4o-mini-tts";
const model5nano = "gpt-5-nano";
const model5mini = "gpt-5-mini";
const model54mini = "gpt-5.4-mini";

const normalizeOpenAiError = (error) => {
    if (!error || typeof error !== "object") {
        return error;
    }
    const statusCode = error.statusCode || error.status;
    if (statusCode && !error.statusCode) {
        error.statusCode = statusCode;
    }
    if (!error.message && error.error?.message) {
        error.message = error.error.message;
    }
    return error;
};

export const analyzeImage = async (image, prompt) => {
    const imageInput = image?.trim();
    if (!imageInput) {
        throw new Error("image is required");
    }

    const finalPrompt = prompt?.trim();
    if (!finalPrompt) {
        throw new Error("prompt is required");
    }

    const model = model41;
    console.log("finalPrompt = " + finalPrompt);
    console.log("using model = " + model);
    const payload = {
        model: model,
        input: [
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: finalPrompt,
                    },
                    {
                        type: "input_image",
                        image_url: `data:image/jpeg;base64,${imageInput}`,
                    },
                ],
            },
        ],
    };
    try {
        const start = Date.now();
        const response = await getClient().responses.create(payload);
        const elapsed = Date.now() - start;
        console.log(`[analyzeImage] OpenAI API responded in ${elapsed}ms`);
        console.log("response.output_text = " + JSON.stringify(response));
        return response.output_text;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
};

const buildPlainTextPayload = (systemPrompt, userPrompt, options = {}) => ({
    model: model4o,
    instructions: systemPrompt,
    input: userPrompt,
    store: true,
    ...options,
});

const buildResearchPayload = (systemPrompt, userPrompt, metadata = {}, options = {}) => ({
    model: model4o,
    instructions: systemPrompt,
    input: userPrompt,
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    store: true,
    metadata: {
        agent: "research",
        step: "1",
        ...metadata,
    },
    ...options,
});

const buildPersonaPayload = (systemPrompt, userPrompt, metadata = {}, options = {}) => ({
    model: model4o,
    instructions: systemPrompt,
    input: userPrompt,
    store: true,
    metadata: {
        agent: "persona",
        step: "2",
        ...metadata,
    },
    ...options,
});

export const answerToPrompt = async (systemPrompt, userPrompt) => {
    if (!systemPrompt?.trim()) {
        throw new Error("system prompt is required");
    }
    if (!userPrompt?.trim()) {
        throw new Error("user prompt is required");
    }
    console.log("systemPrompt = " + systemPrompt);
    console.log("userPrompt = " + userPrompt);
    console.log("using model = " + model4o);
    try {
        const start = Date.now();
        const response = await getClient().responses.create(
            buildPlainTextPayload(systemPrompt, userPrompt),
        );
        const elapsed = Date.now() - start;
        console.log(`[answerToPrompt] response_id=${response.id} elapsed=${elapsed}ms`);
        console.log(`[answerToPrompt] output=${response.output_text}`);
        return response.output_text;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
};

export const researchFromWebSearch = async (systemPrompt, userPrompt, metadata = {}) => {
    if (!systemPrompt?.trim()) {
        throw new Error("system prompt is required");
    }
    if (!userPrompt?.trim()) {
        throw new Error("user prompt is required");
    }
    console.log("[researchFromWebSearch] systemPrompt = " + systemPrompt);
    console.log("[researchFromWebSearch] userPrompt = " + userPrompt);
    console.log("[researchFromWebSearch] using model = " + model4o);
    try {
        const start = Date.now();
        const response = await getClient().responses.create(
            buildResearchPayload(systemPrompt, userPrompt, metadata),
        );
        const elapsed = Date.now() - start;
        console.log(`[researchFromWebSearch] response_id=${response.id} elapsed=${elapsed}ms`);
        console.log(`[researchFromWebSearch] output=${response.output_text}`);
        return response.output_text;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
};

export const personaRetellStreaming = async function* (systemPrompt, userPrompt, metadata = {}) {
    if (!systemPrompt?.trim()) {
        throw new Error("system prompt is required");
    }
    if (!userPrompt?.trim()) {
        throw new Error("user prompt is required");
    }
    console.log("[personaRetellStreaming] systemPrompt = " + systemPrompt);
    console.log("[personaRetellStreaming] userPrompt = " + userPrompt);
    console.log("[personaRetellStreaming] using model (streaming) = " + model4o);
    try {
        const start = Date.now();
        const stream = await getClient().responses.create(
            buildPersonaPayload(systemPrompt, userPrompt, metadata, { stream: true }),
        );
        let output = "";
        let responseId;
        for await (const event of stream) {
            if (event.type === "response.created" && event.response?.id) {
                responseId = event.response.id;
            }
            if (event.type === "response.output_text.delta" && event.delta) {
                output += event.delta;
                yield event.delta;
            }
        }
        const elapsed = Date.now() - start;
        console.log(`[personaRetellStreaming] response_id=${responseId || "(unknown)"} elapsed=${elapsed}ms`);
        console.log(`[personaRetellStreaming] output=${output}`);
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
};

export const textToSpeech = async (inputText, options = {}) => {
    const model = options.model || model40tts;
    const voice = options.voice || "alloy";
    const format = options.format || "mp3";

    console.log("using model = " + model + ", voice = " + voice + ", format = " + format);

    try {
        const t0 = Date.now();
        const response = await getClient().audio.speech.create({
            model,
            voice,
            input: inputText,
            format,
        });
        const t1 = Date.now();

        const arrayBuf = await response.arrayBuffer();
        const t2 = Date.now();

        const audioBuffer = Buffer.from(arrayBuf);
        const base64 = audioBuffer.toString("base64");
        const t3 = Date.now();

        const bodyBytes = arrayBuf.byteLength;
        console.log(
            `[textToSpeech] api=${t1 - t0}ms download=${t2 - t1}ms encode=${t3 - t2}ms total=${t3 - t0}ms bodySize=${bodyBytes}b`,
        );

        return base64;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
};
