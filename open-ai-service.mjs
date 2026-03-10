import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const model4o = "gpt-4o-mini";
const model41 = "gpt-4.1-mini";
const model40tts = "gpt-4o-mini-tts";
const model5nano = "gpt-5-nano";
const model5mini = "gpt-5-mini";

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
    // console.log("payload = " + JSON.stringify(payload));
    try {
        const start = Date.now();
        const response = await openai.responses.create(payload);
        const elapsed = Date.now() - start;
        console.log(`[analyzeImage] OpenAI API responded in ${elapsed}ms`);
        console.log("response.output_text = " + JSON.stringify(response));
        return response.output_text;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
}

export const answerToPrompt = async (systemPrompt, userPrompt) => {
    if (!systemPrompt?.trim()) {
        throw new Error("system prompt is required");
    }
    if (!userPrompt?.trim()) {
        throw new Error("user prompt is required");
    }
    const model = model4o;
    console.log("systemPrompt = " + systemPrompt);
    console.log("userPrompt = " + userPrompt);
    console.log("using model = " + model);
    try {
        const start = Date.now();
        const response = await openai.chat.completions.create({
            model: model,
            messages: [
                {
                    role: "system",
                    content: [
                        {
                            type: "text",
                            text: systemPrompt
                        }
                    ]
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: userPrompt
                        }
                    ]
                }
            ]
        });
        const elapsed = Date.now() - start;
        console.log(`[answerToPrompt] OpenAI API responded in ${elapsed}ms`);
        return response.choices[0].message.content;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
}

export const textToSpeech = async (payload, options = {}) => {
    const inputText = payload.text.trim();
    const model = options.model || model40tts;
    const voice = options.voice || "alloy";
    const format = options.format || "mp3";

    console.log("using model = " + model);

    try {
        const start = Date.now();
        const response = await openai.audio.speech.create({
            model,
            voice,
            input: inputText,
            format,
        });
        const elapsed = Date.now() - start;
        console.log(`[textToSpeech] OpenAI API responded in ${elapsed}ms`);

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return audioBuffer.toString("base64");
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
}