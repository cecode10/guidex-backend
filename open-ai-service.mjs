import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const model4o = "gpt-4o-mini";
const model41 = "gpt-4.1-mini";

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
    const response = await openai.responses.create(payload);
    console.log("response.output_text = " + JSON.stringify(response));
    return response.output_text;
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
}

export const textToSpeech = async (text, options = {}) => {
    const inputText = text?.trim();
    if (!inputText) {
        throw new Error("text is required");
    }

    const model = options.model || "gpt-4o-mini-tts";
    const voice = options.voice || "alloy";
    const format = options.format || "mp3";

    const response = await openai.audio.speech.create({
        model,
        voice,
        input: inputText,
        format,
    });

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return audioBuffer.toString("base64");
}