import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const model4o = "gpt-4o-mini";
const model41 = "gpt-4.1-mini";

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

const buildLocationPrompt = (location) => {
    if (!location) {
        return "";
    }
    return (
        "Location: use the following location optionaly if you need help " +
        "to determine the name of a place or landmark: " +
        JSON.stringify(location)
    );
};

export const analyzeImage = async (image, location) => {
    const imageInput = image?.trim();
    if (!imageInput) {
        throw new Error("image is required");
    }

    const locationPrompt = buildLocationPrompt(location);
    const finalPrompt = [
        "What object is on this image?",
        "Return only its name and nothing else.",
        "Look first for landmarks and famous places, then for objects.",
        "Do not exceed 22 characters.",
        locationPrompt,
    ]
        .filter(Boolean)
        .join("\n");
    console.log("finalPrompt=" + finalPrompt);
    const payload = {
        model: model41,
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
        const response = await openai.responses.create(payload);
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

    console.log("systemPrompt = " + systemPrompt);
    console.log("userPrompt = " + userPrompt);
    try {
        const response = await openai.chat.completions.create({
            model: model4o,
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
        return response.choices[0].message.content;
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
}

export const textToSpeech = async (payload, options = {}) => {
    const inputText = payload.text.trim();
    const model = options.model || "gpt-4o-mini-tts";
    const voice = options.voice || "alloy";
    const format = options.format || "mp3";

    try {
        const response = await openai.audio.speech.create({
            model,
            voice,
            input: inputText,
            format,
        });

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return audioBuffer.toString("base64");
    } catch (error) {
        throw normalizeOpenAiError(error);
    }
}